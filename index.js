const express = require('express');
const cors = require('cors');
const ytdl = require('@distube/ytdl-core');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const youtubedl = require('youtube-dl-exec');
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Store active downloads
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
                url: format.url,
                directUrl: format.url // Store the direct download URL
            }))
            .sort((a, b) => {
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
    return filename
        .replace(/[<>:"/\\|?*]/g, '_')
        .replace(/\s+/g, '_')
        .substring(0, 100);
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

// 2. Direct download endpoint - SIMPLE AND RELIABLE
app.get("/api/video/download", async (req, res) => {
    try {
        let { url, filename, quality } = req.query;

        if (!url) {
            return res.status(400).json({ error: "Missing URL" });
        }

        url = decodeURIComponent(url);

        // If it's a YouTube URL, get the direct download URL first
        if (url.includes('youtube.com') || url.includes('youtu.be')) {
            try {
                // Get video info to find direct URL
                const videoInfo = await getVideoInfo(url);

                // If quality specified, find that format
                let selectedFormat;
                if (quality) {
                    selectedFormat = videoInfo.formats.find(f =>
                        f.itag === quality || f.quality === quality
                    );
                }

                // If no specific quality or not found, use the first available format
                if (!selectedFormat) {
                    // Try to find a good format with both video and audio
                    selectedFormat = videoInfo.formats.find(f => f.hasVideo && f.hasAudio) ||
                        videoInfo.formats[0];
                }

                if (!selectedFormat || !selectedFormat.url) {
                    return res.status(404).json({ error: "No downloadable format found" });
                }

                // Use the direct URL from YouTube
                url = selectedFormat.url;

                // Set filename if not provided
                if (!filename) {
                    const ext = selectedFormat.container || 'mp4';
                    filename = sanitizeFilename(videoInfo.title) + '.' + ext;
                }

                console.log(`Downloading: ${videoInfo.title} (${selectedFormat.quality})`);
                console.log(`Direct URL: ${url.substring(0, 100)}...`);

            } catch (error) {
                console.error('Error getting video info:', error);
                return res.status(500).json({ error: "Failed to get video information" });
            }
        }

        // Default filename if still not set
        filename = filename || "download.mp4";

        // Clean the filename for headers
        const safeFilename = encodeURIComponent(filename).replace(/['"]/g, '');

        // Force download instead of open/play
        res.setHeader("Content-Disposition", `attachment; filename="${safeFilename}"; filename*=UTF-8''${safeFilename}`);
        res.setHeader("Content-Type", "application/octet-stream");

        // Add cache control headers
        res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
        res.setHeader("Pragma", "no-cache");
        res.setHeader("Expires", "0");

        // Choose correct protocol
        const client = url.startsWith("https") ? https : http;

        console.log(`Starting download from: ${url.substring(0, 150)}...`);

        // Request YouTube file with required headers
        client.get(url, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                "Referer": "https://www.youtube.com/",
                "Accept": "*/*",
                "Accept-Language": "en-US,en;q=0.9",
                "Accept-Encoding": "gzip, deflate, br",
                "Range": "bytes=0-", // Important for YouTube
                "Connection": "keep-alive",
                "Sec-Fetch-Dest": "video",
                "Sec-Fetch-Mode": "no-cors",
                "Sec-Fetch-Site": "cross-site"
            }
        }, (response) => {
            console.log(`Response status: ${response.statusCode}`);

            if (response.statusCode >= 400) {
                console.error(`YouTube rejected request: ${response.statusCode}`);
                return res.status(500).send("YouTube rejected the download request");
            }

            // Copy headers from YouTube response
            if (response.headers['content-type']) {
                res.setHeader('Content-Type', response.headers['content-type']);
            }
            if (response.headers['content-length']) {
                res.setHeader('Content-Length', response.headers['content-length']);
                console.log(`File size: ${(response.headers['content-length'] / (1024 * 1024)).toFixed(2)} MB`);
            }

            // Track download progress
            let downloadedBytes = 0;
            const totalBytes = parseInt(response.headers['content-length']) || 0;
            const startTime = Date.now();

            response.on('data', (chunk) => {
                downloadedBytes += chunk.length;
                if (totalBytes > 0) {
                    const percent = (downloadedBytes / totalBytes * 100).toFixed(1);
                    const elapsed = (Date.now() - startTime) / 1000;
                    const speed = downloadedBytes / elapsed / (1024 * 1024); // MB/s

                    // Log progress every 5%
                    if (percent % 5 === 0) {
                        console.log(`Download: ${percent}% (${speed.toFixed(2)} MB/s)`);
                    }
                }
            });

            response.on('end', () => {
                const elapsed = (Date.now() - startTime) / 1000;
                const speed = downloadedBytes / elapsed / (1024 * 1024);
                console.log(`Download completed: ${(downloadedBytes / (1024 * 1024)).toFixed(2)} MB in ${elapsed.toFixed(2)}s (${speed.toFixed(2)} MB/s)`);
            });

            // Pipe the response to client
            response.pipe(res);

        }).on('error', (err) => {
            console.error("Download stream error:", err);
            if (!res.headersSent) {
                res.status(500).send("Download stream error");
            }
        });

    } catch (err) {
        console.error("DOWNLOAD ERROR:", err);
        if (!res.headersSent) {
            res.status(500).json({ error: "Download error: " + err.message });
        }
    }
});

// 3. Alternative simple download using ytdl-core
app.get("/api/video/simple-download", async (req, res) => {
    try {
        const { url, quality = 'highest' } = req.query;

        if (!url) {
            return res.status(400).json({ error: "Missing YouTube URL" });
        }

        if (!ytdl.validateURL(url)) {
            return res.status(400).json({ error: "Invalid YouTube URL" });
        }

        const videoId = ytdl.getURLVideoID(url);
        const info = await ytdl.getInfo(videoId);

        // Get video title for filename
        const title = info.videoDetails.title;
        const safeFilename = sanitizeFilename(title) + '.mp4';

        // Set download headers
        res.header('Content-Disposition', `attachment; filename="${safeFilename}"`);
        res.header('Content-Type', 'video/mp4');

        // Get format based on quality preference
        let format;
        if (quality === 'highest') {
            format = ytdl.chooseFormat(info.formats, { quality: 'highest' });
        } else if (quality === 'lowest') {
            format = ytdl.chooseFormat(info.formats, { quality: 'lowest' });
        } else {
            format = ytdl.chooseFormat(info.formats, { quality });
        }

        console.log(`Downloading: ${title} in ${format.qualityLabel}`);

        // Stream the video directly
        ytdl(url, { format }).pipe(res);

    } catch (error) {
        console.error("Simple download error:", error);
        if (!res.headersSent) {
            res.status(500).json({ error: error.message });
        }
    }
});

// 4. Health check endpoint
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
        <title>YouTube Video Downloader</title>
        <style>
            body {
                font-family: Arial, sans-serif;
                max-width: 1200px;
                margin: 0 auto;
                padding: 20px;
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                min-height: 100vh;
            }
            .container {
                background: white;
                padding: 40px;
                border-radius: 20px;
                box-shadow: 0 20px 60px rgba(0,0,0,0.3);
                margin-top: 30px;
            }
            h1 {
                color: #333;
                text-align: center;
                margin-bottom: 40px;
                font-size: 2.5em;
            }
            .test-form {
                margin: 30px 0;
                padding: 30px;
                background: linear-gradient(135deg, #f5f7fa 0%, #c3cfe2 100%);
                border-radius: 15px;
                border: 2px solid #e0e6ff;
            }
            .url-input {
                width: 70%;
                padding: 15px;
                margin-right: 15px;
                border: 2px solid #667eea;
                border-radius: 10px;
                font-size: 16px;
                box-shadow: 0 4px 6px rgba(0,0,0,0.1);
                transition: all 0.3s;
            }
            .url-input:focus {
                outline: none;
                border-color: #764ba2;
                box-shadow: 0 4px 12px rgba(118, 75, 162, 0.3);
            }
            .btn {
                padding: 15px 30px;
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                color: white;
                border: none;
                border-radius: 10px;
                cursor: pointer;
                font-size: 16px;
                font-weight: bold;
                transition: all 0.3s;
                margin: 5px;
                box-shadow: 0 4px 15px rgba(102, 126, 234, 0.4);
            }
            .btn:hover {
                transform: translateY(-2px);
                box-shadow: 0 6px 20px rgba(102, 126, 234, 0.6);
            }
            .btn-success {
                background: linear-gradient(135deg, #56ab2f 0%, #a8e063 100%);
                box-shadow: 0 4px 15px rgba(86, 171, 47, 0.4);
            }
            .btn-danger {
                background: linear-gradient(135deg, #ff416c 0%, #ff4b2b 100%);
                box-shadow: 0 4px 15px rgba(255, 65, 108, 0.4);
            }
            #results {
                margin-top: 30px;
                padding: 25px;
                background: white;
                border-radius: 15px;
                border: 2px solid #e0e6ff;
                max-height: 600px;
                overflow-y: auto;
            }
            table {
                width: 100%;
                border-collapse: collapse;
                margin-top: 20px;
            }
            th {
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                color: white;
                padding: 15px;
                text-align: left;
                position: sticky;
                top: 0;
            }
            td {
                padding: 12px;
                border-bottom: 1px solid #e0e6ff;
            }
            tr:hover {
                background: #f8f9ff;
                transform: scale(1.01);
                transition: transform 0.2s;
            }
            .download-btn {
                padding: 10px 20px;
                background: linear-gradient(135deg, #56ab2f 0%, #a8e063 100%);
                color: white;
                text-decoration: none;
                border-radius: 8px;
                display: inline-block;
                font-weight: bold;
                transition: all 0.3s;
            }
            .download-btn:hover {
                transform: translateY(-2px);
                box-shadow: 0 4px 15px rgba(86, 171, 47, 0.4);
            }
            .loading {
                text-align: center;
                padding: 40px;
                color: #667eea;
                font-size: 18px;
            }
            .loading:after {
                content: '...';
                animation: dots 1.5s steps(4, end) infinite;
            }
            @keyframes dots {
                0%, 20% { content: ''; }
                40% { content: '.'; }
                60% { content: '..'; }
                80%, 100% { content: '...'; }
            }
            .error {
                color: #ff416c;
                padding: 15px;
                background: #ffe6eb;
                border-radius: 10px;
                margin: 15px 0;
                border-left: 5px solid #ff416c;
            }
            .success {
                color: #56ab2f;
                padding: 15px;
                background: #f0ffe6;
                border-radius: 10px;
                margin: 15px 0;
                border-left: 5px solid #56ab2f;
            }
            .video-info {
                display: flex;
                align-items: center;
                gap: 20px;
                margin: 20px 0;
                padding: 20px;
                background: #f8f9ff;
                border-radius: 10px;
            }
            .video-thumbnail {
                border-radius: 10px;
                box-shadow: 0 8px 25px rgba(0,0,0,0.2);
            }
            .video-details {
                flex: 1;
            }
            .quick-downloads {
                margin: 25px 0;
                text-align: center;
                padding: 20px;
                background: rgba(102, 126, 234, 0.1);
                border-radius: 10px;
            }
            .quick-btn {
                margin: 8px;
            }
            .format-badge {
                display: inline-block;
                padding: 4px 12px;
                background: #e0e6ff;
                border-radius: 20px;
                font-size: 12px;
                font-weight: bold;
                color: #667eea;
                margin-right: 8px;
            }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>🎬 YouTube Video Downloader</h1>
            
            <div class="test-form">
                <h2 style="color: #667eea;">Download Any YouTube Video</h2>
                <p style="color: #666; margin-bottom: 25px;">Enter a YouTube URL below and click "Get Formats" to see all available download options.</p>
                
                <div style="text-align: center; margin-bottom: 20px;">
                    <input type="text" 
                           id="videoUrl" 
                           class="url-input" 
                           placeholder="Enter YouTube URL (e.g., https://www.youtube.com/watch?v=...)" 
                           value="https://www.youtube.com/watch?v=dQw4w9WgXcQ" />
                    <button onclick="getVideoInfo()" class="btn">Get Formats</button>
                </div>
                
                <div class="quick-downloads">
                    <p style="font-weight: bold; margin-bottom: 15px;">Quick Downloads:</p>
                    <button onclick="quickDownload('highest')" class="btn btn-success quick-btn">⬇️ Download Highest Quality</button>
                    <button onclick="quickDownload('lowest')" class="btn quick-btn">⬇️ Download Lowest Quality</button>
                    <button onclick="downloadAudio()" class="btn quick-btn">🎵 Download Audio Only</button>
                </div>
                
                <div id="results"></div>
            </div>
        </div>
        
        <script>
            let currentVideoInfo = null;
            
            async function getVideoInfo() {
                const videoUrl = document.getElementById('videoUrl').value.trim();
                const resultsDiv = document.getElementById('results');
                
                if (!videoUrl) {
                    resultsDiv.innerHTML = '<div class="error">❌ Please enter a YouTube URL</div>';
                    return;
                }
                
                // Simple URL validation
                if (!videoUrl.includes('youtube.com/watch') && !videoUrl.includes('youtu.be/')) {
                    resultsDiv.innerHTML = '<div class="error">❌ Please enter a valid YouTube URL</div>';
                    return;
                }
                
                resultsDiv.innerHTML = '<div class="loading">Loading video information</div>';
                
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
                        currentVideoInfo = data;
                        
                        let html = \`
                            <div class="video-info">
                                <img src="\${data.thumbnail}" width="240" height="135" class="video-thumbnail" />
                                <div class="video-details">
                                    <h3 style="margin-top: 0;">\${data.title}</h3>
                                    <p>⏱️ Duration: \${Math.floor(data.duration / 60)}:\${(data.duration % 60).toString().padStart(2, '0')}</p>
                                    <p>👤 Author: \${data.author}</p>
                                    <p>📊 Formats available: \${data.formats.length}</p>
                                </div>
                            </div>
                            
                            <h3>Available Download Formats:</h3>
                            <table>
                                <thead>
                                    <tr>
                                        <th>Quality</th>
                                        <th>Format</th>
                                        <th>Size</th>
                                        <th>Type</th>
                                        <th>Download</th>
                                    </tr>
                                </thead>
                                <tbody>\`;
                        
                        data.formats.forEach(format => {
                            // Create direct download link
                            const downloadUrl = \`/api/video/download?url=\${encodeURIComponent(videoUrl)}&quality=\${format.itag}\`;
                            
                            // Determine type
                            let typeIcon = '🎬';
                            let typeText = 'Video+Audio';
                            if (format.hasVideo && !format.hasAudio) {
                                typeIcon = '🎞️';
                                typeText = 'Video Only';
                            } else if (!format.hasVideo && format.hasAudio) {
                                typeIcon = '🎵';
                                typeText = 'Audio Only';
                            }
                            
                            // Get codec info
                            const videoCodec = format.videoCodec ? \`<span class="format-badge">\${format.videoCodec.split('.')[0]}</span>\` : '';
                            const audioCodec = format.audioCodec ? \`<span class="format-badge">\${format.audioCodec.split('.')[0]}</span>\` : '';
                            
                            html += \`
                                <tr>
                                    <td><strong>\${format.quality || 'N/A'}</strong></td>
                                    <td>\${format.container.toUpperCase()} \${videoCodec} \${audioCodec}</td>
                                    <td>\${format.filesizeFormatted || 'Unknown'}</td>
                                    <td>\${typeIcon} \${typeText}</td>
                                    <td>
                                        <a href="\${downloadUrl}" 
                                           class="download-btn" 
                                           download="\${data.title.replace(/[^a-z0-9]/gi, '_')}.\${format.container}">
                                            ⬇️ Download
                                        </a>
                                    </td>
                                </tr>\`;
                        });
                        
                        html += '</tbody></table>';
                        resultsDiv.innerHTML = html;
                    } else {
                        resultsDiv.innerHTML = \`<div class="error">❌ Error: \${data.error}</div>\`;
                    }
                } catch (error) {
                    resultsDiv.innerHTML = \`<div class="error">❌ Error: \${error.message}</div>\`;
                }
            }
            
            function quickDownload(quality) {
                const videoUrl = document.getElementById('videoUrl').value.trim();
                if (!videoUrl) {
                    alert('⚠️ Please enter a YouTube URL first');
                    return;
                }
                
                const downloadUrl = \`/api/video/simple-download?url=\${encodeURIComponent(videoUrl)}&quality=\${quality}\`;
                window.open(downloadUrl, '_blank');
            }
            
            function downloadAudio() {
                const videoUrl = document.getElementById('videoUrl').value.trim();
                if (!videoUrl) {
                    alert('⚠️ Please enter a YouTube URL first');
                    return;
                }
                
                // Find an audio-only format
                if (currentVideoInfo) {
                    const audioFormat = currentVideoInfo.formats.find(f => !f.hasVideo && f.hasAudio);
                    if (audioFormat) {
                        const downloadUrl = \`/api/video/download?url=\${encodeURIComponent(videoUrl)}&quality=\${audioFormat.itag}\`;
                        window.open(downloadUrl, '_blank');
                    } else {
                        alert('No audio-only format found. Try a regular download instead.');
                    }
                } else {
                    alert('Please get video formats first by clicking "Get Formats"');
                }
            }
            
            // Auto-load example on page load
            window.onload = function() {
                getVideoInfo();
            };
            
            // Allow pressing Enter in input field
            document.getElementById('videoUrl').addEventListener('keypress', function(e) {
                if (e.key === 'Enter') {
                    getVideoInfo();
                }
            });
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
    console.log(`🚀 Server is running on http://localhost:${PORT}`);
    console.log('📋 API Endpoints:');
    console.log(`  POST   http://localhost:${PORT}/api/video/info`);
    console.log(`  GET    http://localhost:${PORT}/api/video/download?url=URL&quality=ITAG`);
    console.log(`  GET    http://localhost:${PORT}/api/video/simple-download?url=URL&quality=highest`);
    console.log(`  GET    http://localhost:${PORT}/api/health`);
    console.log('\n💡 Usage:');
    console.log('1. Visit http://localhost:3000 in your browser');
    console.log('2. Enter a YouTube URL');
    console.log('3. Click "Get Formats" to see all available options');
    console.log('4. Click the download button for your preferred format');
    console.log('5. The file will download directly to your device!');
});