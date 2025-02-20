# YouTube Video Downloader
A desktop application built with Electron and FastAPI that allows users to download YouTube videos based on search queries, watch later playlists, and unwatched videos from subscribed channels.

## Features
- YouTube OAuth2 authentication for accessing user data
- Download videos based on:
- Search queries with category filtering
- Watch Later playlist
- Unwatched videos from subscribed channels
- Real-time download progress tracking
- User profile display
- Customizable download folder selection
- Support for multiple concurrent downloads
- WebSocket-based progress updates
- Secure session management
- Error handling and retry mechanisms

## Prerequisites

- Python 3.7+
- Node.js and npm
- Google Cloud Console project with YouTube Data API v3 enabled

## Installation

1. Clone the repository:

bashCopygit clone <repository-url>
cd youtube-downloader

2. Install Python dependencies:

bashCopypip install fastapi uvicorn google-auth-oauthlib google-auth-httplib2 google-api-python-client yt-dlp aiohttp

3. Install Node.js dependencies:

bashCopynpm install

4. Set up Google OAuth 2.0 credentials:

- Go to the Google Cloud Console
- Create a new project or select an existing one
- Enable the YouTube Data API v3
- Create OAuth 2.0 credentials
- Download the credentials and save them as credentials.json in the project root

## Configuration

1. Update the following constants in main.py if needed:

- REDIRECT_URI: The OAuth2 callback URL
- CLIENT_SECRETS_FILE: Path to your Google OAuth credentials file
- SCOPES: OAuth2 scopes required by the application


2. Adjust security settings in main.py for production:

- Set secure=True for cookies
- Update CORS settings
- Use HTTPS for production deployments

## Running the Application

1. Start the FastAPI backend:

bashCopypython main.py

2. In a separate terminal, start the Electron application:

bashCopynpm start

## Usage

1. Launch the application
2. Click "Sign in with YouTube" to authenticate
3. Configure download options:

- Enter a search query (optional)
- Select a video category (optional)
- Set the number of videos to download
- Choose download sources (Search, Watch Later, Unwatched)
4. Select a download folder
5. Click "Start Download" to begin

## Security Features

- Cross-Origin Resource Sharing (CORS) protection
- Session-based authentication
- Secure cookie handling
- WebSocket connection management
- Rate limiting for progress updates
- Error handling and validation
- Credential refresh management

## Error Handling
The application includes comprehensive error handling for:

- Authentication failures
- Network issues
- Download errors
- WebSocket disconnections
- Invalid user input
- API rate limiting

## Development Notes

- The frontend is built with vanilla JavaScript and basic CSS
- Uses Electron's IPC for communication between main and renderer processes
- Implements a WebSocket manager for real-time progress updates
- Uses yt-dlp for video downloads
- Includes automatic credential refresh mechanism

## Limitations

- Maximum of 50 videos per download session
- YouTube API quotas apply
- Requires stable internet connection
- Some videos may not be available for download
