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
    return filename.replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, '_').substring(0, 200);
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

// 2. API to download video in specific format - FIXED VERSION
app.get('/api/video/download', async (req, res) => {
    try {
        const { videoUrl, itag, filename } = req.query;

        if (!videoUrl || !itag) {
            return res.status(400).json({ error: 'Video URL and format itag are required' });
        }

        if (!ytdl.validateURL(videoUrl)) {
            return res.status(400).json({ error: 'Invalid YouTube URL' });
        }

        console.log(`Starting download for URL: ${videoUrl}, format: ${itag}`);

        // Get video info to validate format and get title
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
            console.error(`Format ${itag} not found for video ${videoInfo.id}`);
            return res.status(400).json({
                error: 'Requested format not available',
                availableFormats: videoInfo.formats.map(f => f.format_id)
            });
        }

        console.log(`Found format: ${format.format_id}, extension: ${format.ext}`);

        // Generate filename
        let downloadFilename = filename || sanitizeFilename(videoInfo.title);
        const extension = format.ext || 'mp4';

        // Ensure proper extension
        if (!downloadFilename.toLowerCase().endsWith(`.${extension}`)) {
            downloadFilename += `.${extension}`;
        }

        // Clean filename for Content-Disposition header
        const safeFilename = encodeURIComponent(downloadFilename).replace(/['"]/g, '');

        // Set proper headers for download
        res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"; filename*=UTF-8''${safeFilename}`);

        // Set appropriate content type
        if (format.ext === 'mp4') {
            res.setHeader('Content-Type', 'video/mp4');
        } else if (format.ext === 'webm') {
            res.setHeader('Content-Type', 'video/webm');
        } else if (format.ext === 'mp3') {
            res.setHeader('Content-Type', 'audio/mpeg');
        } else if (format.ext === 'm4a') {
            res.setHeader('Content-Type', 'audio/mp4');
        } else {
            res.setHeader('Content-Type', 'application/octet-stream');
        }

        // If format has filesize, set Content-Length
        if (format.filesize) {
            res.setHeader('Content-Length', format.filesize);
            console.log(`File size: ${(format.filesize / (1024 * 1024)).toFixed(2)} MB`);
        }

        // Prepare yt-dlp command for streaming
        const options = {
            format: itag,
            noCheckCertificates: true,
            noWarnings: true,
            output: '-', // Output to stdout
            addHeader: [
                'referer:youtube.com',
                'user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            ],
            formatSort: 'res,ext:mp4:m4a',
            verbose: true,
            forceIpv4: true,
            socketTimeout: 30000,
            retries: 10,
            fragmentRetries: 10,
            skipUnavailableFragments: true
        };

        // Execute yt-dlp and stream directly to response
        const childProcess = youtubedl.raw(videoUrl, options);

        let downloadedBytes = 0;
        const startTime = Date.now();

        // Stream the output
        childProcess.stdout.on('data', (chunk) => {
            downloadedBytes += chunk.length;
            if (res.writable) {
                res.write(chunk);
            }
        });

        childProcess.stdout.on('end', () => {
            const endTime = Date.now();
            const duration = (endTime - startTime) / 1000;
            const speed = downloadedBytes / duration / (1024 * 1024); // MB/s
            console.log(`Download completed: ${(downloadedBytes / (1024 * 1024)).toFixed(2)} MB in ${duration.toFixed(2)}s (${speed.toFixed(2)} MB/s)`);
            res.end();
        });

        childProcess.stderr.on('data', (data) => {
            const message = data.toString().trim();
            if (message && message.includes('[download]')) {
                console.log(`yt-dlp progress: ${message}`);
            } else if (message) {
                console.log(`yt-dlp: ${message}`);
            }
        });

        childProcess.on('error', (error) => {
            console.error('yt-dlp process error:', error);
            if (!res.headersSent) {
                res.status(500).json({ error: 'Download process error: ' + error.message });
            } else {
                res.end();
            }
        });

        childProcess.on('close', (code) => {
            console.log(`yt-dlp process exited with code ${code}`);
            if (code !== 0 && !res.headersSent) {
                res.status(500).json({ error: `Download failed with exit code ${code}` });
            }
        });

        // Handle client disconnect
        req.on('close', () => {
            console.log('Client disconnected, killing yt-dlp process');
            if (!childProcess.killed) {
                childProcess.kill('SIGTERM');
            }
        });

    } catch (error) {
        console.error('Download error:', error);
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

// Serve an improved frontend for testing
app.get('/', (req, res) => {
    const html = `
    <!DOCTYPE html>
    <html>
    <head>
        <title>YouTube Video Downloader API</title>
        <style>
            body {
                font-family: Arial, sans-serif;
                max-width: 1000px;
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
                margin-bottom: 30px;
            }
            .test-form {
                margin: 30px 0;
                padding: 25px;
                background: #e8f4fd;
                border-radius: 8px;
                border: 1px solid #b3d9ff;
            }
            .url-input {
                width: 80%;
                padding: 12px;
                margin-right: 10px;
                border: 2px solid #007bff;
                border-radius: 5px;
                font-size: 16px;
            }
            .btn {
                padding: 12px 24px;
                background: #28a745;
                color: white;
                border: none;
                border-radius: 5px;
                cursor: pointer;
                font-size: 16px;
                font-weight: bold;
                transition: background 0.3s;
            }
            .btn:hover {
                background: #218838;
            }
            .btn-info {
                background: #007bff;
            }
            .btn-info:hover {
                background: #0056b3;
            }
            #results {
                margin-top: 20px;
                padding: 20px;
                background: white;
                border-radius: 5px;
                border: 1px solid #ddd;
            }
            table {
                width: 100%;
                border-collapse: collapse;
                margin-top: 15px;
            }
            th {
                background: #007bff;
                color: white;
                padding: 12px;
                text-align: left;
            }
            td {
                padding: 10px;
                border-bottom: 1px solid #ddd;
            }
            tr:hover {
                background: #f5f5f5;
            }
            .download-btn {
                padding: 8px 16px;
                background: #28a745;
                color: white;
                text-decoration: none;
                border-radius: 4px;
                display: inline-block;
            }
            .download-btn:hover {
                background: #218838;
            }
            .loading {
                text-align: center;
                padding: 20px;
                color: #007bff;
            }
            .error {
                color: #dc3545;
                padding: 10px;
                background: #f8d7da;
                border-radius: 4px;
                margin: 10px 0;
            }
            .success {
                color: #28a745;
                padding: 10px;
                background: #d4edda;
                border-radius: 4px;
                margin: 10px 0;
            }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>YouTube Video Downloader API</h1>
            
            <div class="test-form">
                <h2>Download YouTube Videos</h2>
                <p>Enter a YouTube URL and click "Get Formats" to see available download options.</p>
                
                <div>
                    <input type="text" 
                           id="videoUrl" 
                           class="url-input" 
                           placeholder="Enter YouTube URL (e.g., https://www.youtube.com/watch?v=...)" 
                           value="https://www.youtube.com/watch?v=dQw4w9WgXcQ" />
                    <button onclick="getVideoInfo()" class="btn btn-info">Get Formats</button>
                </div>
                
                <div id="results"></div>
            </div>
        </div>
        
        <script>
            async function getVideoInfo() {
                const videoUrl = document.getElementById('videoUrl').value.trim();
                const resultsDiv = document.getElementById('results');
                
                if (!videoUrl) {
                    resultsDiv.innerHTML = '<div class="error">Please enter a YouTube URL</div>';
                    return;
                }
                
                // Simple URL validation
                if (!videoUrl.includes('youtube.com/watch') && !videoUrl.includes('youtu.be/')) {
                    resultsDiv.innerHTML = '<div class="error">Please enter a valid YouTube URL</div>';
                    return;
                }
                
                resultsDiv.innerHTML = '<div class="loading">Loading video information...</div>';
                
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
                            <div class="success">
                                <h3>\${data.title}</h3>
                                <p>Duration: \${Math.floor(data.duration / 60)}:\${(data.duration % 60).toString().padStart(2, '0')} | Author: \${data.author}</p>
                                <img src="\${data.thumbnail}" width="320" style="border-radius: 5px; margin: 10px 0;" />
                            </div>
                            <h4>Available Formats:</h4>
                            <table>
                                <thead>
                                    <tr>
                                        <th>Quality</th>
                                        <th>Format</th>
                                        <th>Size</th>
                                        <th>Video/Audio</th>
                                        <th>Action</th>
                                    </tr>
                                </thead>
                                <tbody>\`;
                        
                        data.formats.forEach(format => {
                            // Create direct download link
                            const downloadUrl = \`/api/video/download?videoUrl=\${encodeURIComponent(videoUrl)}&itag=\${format.itag}\`;
                            
                            // Determine type icon
                            let typeIcon = '📹';
                            let typeText = 'Video+Audio';
                            if (format.hasVideo && !format.hasAudio) {
                                typeIcon = '🎞️';
                                typeText = 'Video Only';
                            } else if (!format.hasVideo && format.hasAudio) {
                                typeIcon = '🎵';
                                typeText = 'Audio Only';
                            }
                            
                            html += \`
                                <tr>
                                    <td><strong>\${format.quality || 'N/A'}</strong></td>
                                    <td>\${format.container.toUpperCase()}</td>
                                    <td>\${format.filesizeFormatted || 'Unknown'}</td>
                                    <td>\${typeIcon} \${typeText}</td>
                                    <td>
                                        <a href="\${downloadUrl}" 
                                           class="download-btn" 
                                           download="\${data.title.replace(/[^a-z0-9]/gi, '_')}.\${format.container}">
                                            Download
                                        </a>
                                    </td>
                                </tr>\`;
                        });
                        
                        html += '</tbody></table>';
                        resultsDiv.innerHTML = html;
                    } else {
                        resultsDiv.innerHTML = \`<div class="error">Error: \${data.error}</div>\`;
                    }
                } catch (error) {
                    resultsDiv.innerHTML = \`<div class="error">Error: \${error.message}</div>\`;
                }
            }
            
            // Load example on page load
            window.onload = function() {
                getVideoInfo();
            };
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