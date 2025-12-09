const express = require('express');
const cors = require('cors');
const ytdl = require('@distube/ytdl-core');
const fs = require('fs');
const path = require('path');
const youtubedl = require('youtube-dl-exec');
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Store active downloads (in production, use Redis or database)
const activeDownloads = new Map();

// Helper function to get video info


async function getVideoInfo(videoUrl) {
    try {
        console.log("Processing URL:", videoUrl);

        // Use yt-dlp to get video info
        const result = await youtubedl(videoUrl, {
            dumpJson: true,
            noCheckCertificates: true,
            noWarnings: true,
            preferFreeFormats: true,
            addHeader: [
                'referer:youtube.com',
                'user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            ]
        });

        console.log("Successfully got info for:", result.title);

        // Process formats from yt-dlp response
        const formats = result.formats
            .filter(format => format.url && (format.vcodec !== 'none' || format.acodec !== 'none'))
            .map(format => ({
                itag: format.format_id,
                quality: format.quality || 
                        (format.height ? format.height + 'p' : 
                         format.width ? format.width + 'x' + format.height : 'unknown'),
                container: format.ext,
                hasVideo: format.vcodec !== 'none',
                hasAudio: format.acodec !== 'none',
                videoCodec: format.vcodec,
                audioCodec: format.acodec,
                bitrate: format.tbr || format.abr || 0,
                filesize: format.filesize,
                filesizeFormatted: format.filesize ? 
                    (format.filesize / (1024 * 1024)).toFixed(2) + ' MB' : 'Unknown',
                approxDurationMs: format.duration ? format.duration * 1000 : 0,
                fps: format.fps,
                url: format.url
            }))
            .sort((a, b) => {
                // Sort by quality (higher first)
                const aHeight = parseInt(a.quality) || 0;
                const bHeight = parseInt(b.quality) || 0;
                return bHeight - aHeight;
            });

        return {
            videoId: result.id,
            title: result.title,
            duration: Math.floor(result.duration),
            thumbnail: result.thumbnail,
            author: result.uploader,
            formats: formats
        };
    } catch (error) {
        console.error("Error in getVideoInfo:", error.message);
        throw new Error(`Failed to get video info: ${error.message}`);
    }
}

// Helper function to sanitize filename
function sanitizeFilename(filename) {
    return filename.replace(/[^a-z0-9]/gi, '_').toLowerCase();
}

// 1. API to get video info and available formats
app.post('/api/video/info', async (req, res) => {
    try {
        const { videoUrl } = req.body;

        if (!videoUrl) {
            return res.status(400).json({ error: 'Video URL is required' });
        }

        if (!ytdl.validateURL(videoUrl)) {
            return res.status(400).json({ error: 'Invalid YouTube URL' });
        }

        const videoInfo = await getVideoInfo(videoUrl);
        res.json(videoInfo);
    } catch (error) {
        console.error('Error getting video info:', error);
        res.status(500).json({ error: error.message });
    }
});

// 2. API to download video in specific format

// 2. API to download video in specific format
app.get('/api/video/download', async (req, res) => {
    let downloadId;
    let childProcess;
    let progressInterval;

    try {
        const { videoUrl, itag, filename } = req.query;

        if (!videoUrl || !itag) {
            return res.status(400).json({ error: 'Video URL and format itag are required' });
        }

        // Create download tracker
        downloadId = Date.now().toString();
        activeDownloads.set(downloadId, {
            videoId: new URL(videoUrl).searchParams.get('v') || videoUrl.split('/').pop(),
            startedAt: new Date(),
            progress: 0,
            status: 'starting'
        });

        console.log(`Starting download ${downloadId} for URL: ${videoUrl}, format: ${itag}`);

        // First, get video info to validate format
        const videoInfo = await youtubedl(videoUrl, {
            dumpJson: true,
            noCheckCertificates: true,
            noWarnings: true,
            preferFreeFormats: true,
            addHeader: [
                'referer:youtube.com',
                'user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            ]
        });

        // Find the requested format
        const format = videoInfo.formats.find(f => f.format_id === itag.toString());
        if (!format) {
            activeDownloads.delete(downloadId);
            console.error(`Format ${itag} not found for video ${videoInfo.id}`);
            return res.status(400).json({ 
                error: 'Requested format not available',
                availableFormats: videoInfo.formats.map(f => f.format_id)
            });
        }

        console.log(`Found format: ${format.format_id}, extension: ${format.ext}`);

        // Generate filename if not provided
        let downloadFilename = filename || sanitizeFilename(videoInfo.title);
        const extension = format.ext || 'mp4';
        if (!downloadFilename.endsWith(`.${extension}`)) {
            downloadFilename += `.${extension}`;
        }

        // Set headers for download
        res.header('Content-Disposition', `attachment; filename="${downloadFilename}"`);
        res.header('Content-Type', 'application/octet-stream');

        // Update download tracker
        activeDownloads.get(downloadId).title = videoInfo.title;
        activeDownloads.get(downloadId).status = 'downloading';
        activeDownloads.get(downloadId).totalSize = format.filesize;
        activeDownloads.get(downloadId).format = format.format_id;

        // Prepare yt-dlp command
        const args = [
            videoUrl,
            '--format', itag,
            '--no-check-certificates',
            '--no-warnings',
            '--output', '-',
            '--add-header', 'referer:youtube.com',
            '--add-header', 'user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        ];

        // Add format sort preference for better compatibility
        args.push('--format-sort', 'res,ext:mp4:m4a');

        console.log('Executing yt-dlp with args:', args);

        // Execute yt-dlp
        childProcess = youtubedl.raw(videoUrl, {
            format: itag,
            noCheckCertificates: true,
            noWarnings: true,
            output: '-',
            addHeader: [
                'referer:youtube.com',
                'user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            ],
            formatSort: 'res,ext:mp4:m4a',
            verbose: true
        });

        let downloadedBytes = 0;
        let lastProgressUpdate = Date.now();

        // Track progress
        if (format.filesize) {
            progressInterval = setInterval(() => {
                if (activeDownloads.has(downloadId)) {
                    const progress = format.filesize ? 
                        (downloadedBytes / format.filesize) * 100 : 0;
                    activeDownloads.get(downloadId).progress = Math.min(100, Math.round(progress));
                    activeDownloads.get(downloadId).downloadedBytes = downloadedBytes;
                    activeDownloads.get(downloadId).speed = 
                        downloadedBytes / ((Date.now() - lastProgressUpdate) / 1000);
                }
            }, 1000);
        }

        // Pipe stdout to response
        childProcess.stdout.on('data', (chunk) => {
            downloadedBytes += chunk.length;
            if (res.writable) {
                res.write(chunk);
            }
        });

        childProcess.stdout.on('end', () => {
            console.log(`Download ${downloadId} completed: ${downloadedBytes} bytes`);
            clearInterval(progressInterval);
            if (res.writable) {
                res.end();
            }
            activeDownloads.delete(downloadId);
        });

        // Handle stderr (yt-dlp logs)
        childProcess.stderr.on('data', (data) => {
            const message = data.toString().trim();
            if (message && !message.includes('[download]')) {
                console.log(`yt-dlp: ${message}`);
            }
        });

        // Handle process completion
        childProcess.on('close', (code, signal) => {
            console.log(`yt-dlp process closed: code=${code}, signal=${signal}`);
            clearInterval(progressInterval);
            activeDownloads.delete(downloadId);
            
            if (code !== 0 && !res.headersSent) {
                res.status(500).json({ error: `Download failed with code ${code}` });
            }
        });

        childProcess.on('error', (error) => {
            console.error('yt-dlp process error:', error);
            clearInterval(progressInterval);
            activeDownloads.delete(downloadId);
            if (!res.headersSent) {
                res.status(500).json({ error: 'Download process error: ' + error.message });
            }
        });

        // Handle client disconnect
        req.on('close', () => {
            console.log(`Client disconnected from download ${downloadId}`);
            clearInterval(progressInterval);
            
            if (childProcess && !childProcess.killed) {
                console.log(`Killing yt-dlp process for download ${downloadId}`);
                childProcess.kill('SIGTERM');
            }
            
            if (activeDownloads.has(downloadId)) {
                activeDownloads.get(downloadId).status = 'cancelled';
                setTimeout(() => activeDownloads.delete(downloadId), 5000);
            }
        });

        // Handle request timeout
        req.on('timeout', () => {
            console.log(`Request timeout for download ${downloadId}`);
            clearInterval(progressInterval);
            if (childProcess && !childProcess.killed) {
                childProcess.kill('SIGTERM');
            }
        });

    } catch (error) {
        console.error('Download setup error:', error);
        clearInterval(progressInterval);
        
        if (downloadId && activeDownloads.has(downloadId)) {
            activeDownloads.delete(downloadId);
        }
        
        if (childProcess && !childProcess.killed) {
            childProcess.kill('SIGTERM');
        }
        
        if (!res.headersSent) {
            res.status(500).json({ 
                error: 'Download failed: ' + error.message,
                details: error.stack
            });
        }
    }
});

// 3. API to get audio-only formats
app.post('/api/video/audio-formats', async (req, res) => {
    try {
        const { videoUrl } = req.body;

        if (!videoUrl) {
            return res.status(400).json({ error: 'Video URL is required' });
        }

        if (!ytdl.validateURL(videoUrl)) {
            return res.status(400).json({ error: 'Invalid YouTube URL' });
        }

        const videoId = ytdl.getURLVideoID(videoUrl);
        const info = await ytdl.getInfo(videoId);

        const audioFormats = info.formats
            .filter(format => format.hasAudio && !format.hasVideo)
            .map(format => ({
                itag: format.itag,
                container: format.container,
                audioCodec: format.audioCodec,
                audioBitrate: format.audioBitrate,
                contentLength: format.contentLength,
                approxDurationMs: format.approxDurationMs
            }));

        res.json({
            videoId,
            title: info.videoDetails.title,
            audioFormats
        });
    } catch (error) {
        console.error('Error getting audio formats:', error);
        res.status(500).json({ error: error.message });
    }
});

// 4. API to get active downloads
app.get('/api/downloads/active', (req, res) => {
    const downloads = Array.from(activeDownloads.entries()).map(([id, data]) => ({
        id,
        ...data
    }));
    res.json({ activeDownloads: downloads });
});

// 5. API to cancel a download
app.delete('/api/downloads/:id', (req, res) => {
    const { id } = req.params;

    if (activeDownloads.has(id)) {
        activeDownloads.delete(id);
        res.json({ message: 'Download cancelled' });
    } else {
        res.status(404).json({ error: 'Download not found' });
    }
});

// 6. Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        activeDownloads: activeDownloads.size
    });
});

// Serve a simple frontend for testing
app.get('/', (req, res) => {
    const html = `
    <!DOCTYPE html>
    <html>
    <head>
        <title>YouTube Video Downloader API</title>
        <style>
            body {
                font-family: Arial, sans-serif;
                max-width: 800px;
                margin: 0 auto;
                padding: 20px;
                background-color: #f5f5f5;
            }
            .container {
                background: white;
                padding: 30px;
                border-radius: 10px;
                box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            }
            h1 {
                color: #333;
                text-align: center;
            }
            .endpoint {
                background: #f8f9fa;
                padding: 15px;
                margin: 15px 0;
                border-left: 4px solid #007bff;
                border-radius: 5px;
            }
            .method {
                display: inline-block;
                padding: 5px 10px;
                background: #007bff;
                color: white;
                border-radius: 3px;
                font-weight: bold;
                margin-right: 10px;
            }
            code {
                background: #e9ecef;
                padding: 2px 5px;
                border-radius: 3px;
                font-family: monospace;
            }
            .test-form {
                margin: 20px 0;
                padding: 20px;
                background: #e8f4fd;
                border-radius: 5px;
            }
            input[type="text"] {
                width: 70%;
                padding: 10px;
                margin-right: 10px;
                border: 1px solid #ddd;
                border-radius: 5px;
            }
            button {
                padding: 10px 20px;
                background: #28a745;
                color: white;
                border: none;
                border-radius: 5px;
                cursor: pointer;
            }
            button:hover {
                background: #218838;
            }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>YouTube Video Downloader API</h1>
            <p>Test the API endpoints below:</p>
            
            <div class="test-form">
                <h3>Test Video Info Endpoint</h3>
                <input type="text" id="videoUrl" placeholder="Enter YouTube URL (e.g., https://www.youtube.com/watch?v=...)" />
                <button onclick="getVideoInfo()">Get Formats</button>
                <div id="results"></div>
            </div>
            
  
        </div>
        
        <script>
            async function getVideoInfo() {
                const videoUrl = document.getElementById('videoUrl').value;
                const resultsDiv = document.getElementById('results');
                
                if (!videoUrl) {
                    resultsDiv.innerHTML = '<p style="color: red;">Please enter a YouTube URL</p>';
                    return;
                }
                
                resultsDiv.innerHTML = '<p>Loading...</p>';
                
                try {
                    const response = await fetch('/api/video/info', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify({ videoUrl })
                    });
                    
                    const data = await response.json();
                    
                    if (response.ok) {
                        let html = \`
                            <h4>\${data.title}</h4>
                            <p>Duration: \${Math.floor(data.duration / 60)}:\${(data.duration % 60).toString().padStart(2, '0')}</p>
                            <img src="\${data.thumbnail}" width="200" />
                            <h4>Available Formats:</h4>
                            <table border="1" cellpadding="8" style="width: 100%; border-collapse: collapse;">
                                <thead>
                                    <tr>
                                        <th>Quality</th>
                                        <th>Format</th>
                                        <th>Codec</th>
                                        <th>Action</th>
                                    </tr>
                                </thead>
                                <tbody>\`;
                        
                        data.formats.forEach(format => {
                            const downloadUrl = \`/api/video/download?videoUrl=\${encodeURIComponent(videoUrl)}&itag=\${format.itag}\`;
                            html += \`
                                <tr>
                                    <td>\${format.quality || 'N/A'}</td>
                                    <td>\${format.container}</td>
                                    <td>\${format.videoCodec || format.audioCodec || 'N/A'}</td>
                                    <td><a href="\${downloadUrl}" target="_blank">Download</a></td>
                                </tr>\`;
                        });
                        
                        html += '</tbody></table>';
                        resultsDiv.innerHTML = html;
                    } else {
                        resultsDiv.innerHTML = \`<p style="color: red;">Error: \${data.error}</p>\`;
                    }
                } catch (error) {
                    resultsDiv.innerHTML = \`<p style="color: red;">Error: \${error.message}</p>\`;
                }
            }
        </script>
    </body>
    </html>
    `;
    res.send(html);
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ error: 'Something went wrong!' });
});

// Start server
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
    console.log('API Endpoints:');
    console.log(`  POST   http://localhost:${PORT}/api/video/info`);
    console.log(`  GET    http://localhost:${PORT}/api/video/download?videoUrl=URL&itag=FILTER`);
    console.log(`  POST   http://localhost:${PORT}/api/video/audio-formats`);
    console.log(`  GET    http://localhost:${PORT}/api/downloads/active`);
    console.log(`  GET    http://localhost:${PORT}/api/health`);
});