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

// Set EJS as view engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Static files (if needed)
app.use(express.static(path.join(__dirname, 'public')));

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

// 1. Render home page
app.get('/', (req, res) => {
    res.render('index', { 
        title: 'YouTube Video Downloader',
        videoUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        videoInfo: null,
        error: null
    });
});

// 2. API to get video info and available formats
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

// 3. API endpoint to process video info and render results page
app.post('/process', async (req, res) => {
    try {
        const { videoUrl } = req.body;

        if (!videoUrl) {
            return res.render('index', {
                title: 'YouTube Video Downloader',
                videoUrl: videoUrl || '',
                videoInfo: null,
                error: 'Please enter a YouTube URL'
            });
        }

        if (!ytdl.validateURL(videoUrl)) {
            return res.render('index', {
                title: 'YouTube Video Downloader',
                videoUrl: videoUrl,
                videoInfo: null,
                error: 'Invalid YouTube URL. Please enter a valid YouTube URL.'
            });
        }

        const videoInfo = await getVideoInfo(videoUrl);
        
        // Format duration for display
        videoInfo.durationFormatted = `${Math.floor(videoInfo.duration / 60)}:${(videoInfo.duration % 60).toString().padStart(2, '0')}`;
        
        res.render('results', {
            title: `${videoInfo.title} - Download Options`,
            videoUrl: videoUrl,
            videoInfo: videoInfo,
            sanitizeFilename: sanitizeFilename,
            error: null
        });

    } catch (error) {
        console.error('Error processing video:', error);
        res.render('index', {
            title: 'YouTube Video Downloader',
            videoUrl: req.body.videoUrl || '',
            videoInfo: null,
            error: `Error: ${error.message}`
        });
    }
});

// 4. Direct download endpoint - SIMPLE AND RELIABLE
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

// 5. Alternative simple download using ytdl-core
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

// 6. Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        activeDownloads: activeDownloads.size
    });
});

// 7. About page (optional)
app.get('/about', (req, res) => {
    res.render('about', {
        title: 'About - YouTube Downloader'
    });
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).render('error', {
        title: 'Error',
        message: 'Something went wrong!',
        error: err
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).render('error', {
        title: 'Page Not Found',
        message: 'The page you are looking for does not exist.',
        error: null
    });
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Server is running on http://localhost:${PORT}`);
    console.log('📋 Pages:');
    console.log(`  GET    http://localhost:${PORT}/ (Home Page)`);
    console.log(`  POST   http://localhost:${PORT}/process (Process Video)`);
    console.log(`  GET    http://localhost:${PORT}/about (About Page)`);
    console.log('\n📋 API Endpoints:');
    console.log(`  POST   http://localhost:${PORT}/api/video/info`);
    console.log(`  GET    http://localhost:${PORT}/api/video/download?url=URL&quality=ITAG`);
    console.log(`  GET    http://localhost:${PORT}/api/video/simple-download?url=URL&quality=highest`);
    console.log(`  GET    http://localhost:${PORT}/api/health`);
    console.log('\n💡 Usage:');
    console.log('1. Visit http://localhost:3000 in your browser');
    console.log('2. Enter a YouTube URL and click "Process Video"');
    console.log('3. Select your preferred format and download');
});