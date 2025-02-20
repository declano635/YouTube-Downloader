from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect, Request, Depends, Response
from fastapi.responses import RedirectResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import OAuth2PasswordBearer
from pydantic import BaseModel
import yt_dlp
import os
import asyncio
import json
import warnings
import googleapiclient.discovery
from googleapiclient.errors import HttpError
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import Flow
from google.oauth2 import id_token
from google.auth.transport.requests import Request as GoogleRequest
from google.auth.transport import requests
import logging
from pathlib import Path
from typing import Optional, Dict, List
from datetime import datetime, timedelta
from functools import partial
import aiohttp
from starlette.middleware.sessions import SessionMiddleware
import base64
import json

def encode_state(client_id: str) -> str:
    """Encode client ID and other state information"""
    try:
        state_data = {
            "client_id": client_id,
            "timestamp": str(datetime.now().timestamp())
        }
        state_json = json.dumps(state_data)
        return base64.urlsafe_b64encode(state_json.encode()).decode()
    except Exception as e:
        logger.error(f"Error encoding state: {e}")
        return ""

def decode_state(state: str) -> dict:
    """Decode state information"""
    try:
        if not state:
            return {}
        decoded_bytes = base64.urlsafe_b64decode(state.encode())
        state_data = json.loads(decoded_bytes.decode())
        return state_data
    except Exception as e:
        logger.error(f"Error decoding state: {e}")
        return {}

# Enhanced logging setup
logging.basicConfig(
    level=logging.DEBUG,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Filter out googleapiclient warning
warnings.filterwarnings('ignore', message='file_cache is only supported with oauth2client<4.0.0')

# Set up logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Initialize FastAPI app
app = FastAPI()

# Add SessionMiddleware first
app.add_middleware(
    SessionMiddleware,
    secret_key="your-secret-key-here",
    max_age=3600,  # 1 hour
    same_site="lax",
    https_only=False,  # Set to True in production
    session_cookie="session",
    domain="localhost"
)

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "app://.", "http://localhost:8000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["Set-Cookie"],
)

@app.middleware("http")
async def add_security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["X-XSS-Protection"] = "1; mode=block"
    return response

# OAuth 2.0 setup
SCOPES = [
    "https://www.googleapis.com/auth/youtube.readonly",
    "https://www.googleapis.com/auth/youtube.force-ssl",
    "https://www.googleapis.com/auth/userinfo.profile",
    "https://www.googleapis.com/auth/userinfo.email",
    "openid"
]

REDIRECT_URI = "http://localhost:8000/auth/callback"
CLIENT_SECRETS_FILE = "credentials.json"

# Models
class DownloadRequest(BaseModel):
    query: Optional[str] = None
    category: Optional[str] = None
    numVideos: int
    folder: str
    useRecommended: bool = False
    useWatchLater: bool = False
    useUnwatched: bool = False

class ProgressManager:
    def __init__(self, websocket_manager, client_id, video_id):
        self.manager = websocket_manager
        self.client_id = client_id
        self.video_id = video_id
        self._last_update = datetime.now()
        self.update_interval = timedelta(milliseconds=100)  # Limit updates to 10 times per second

    def create_hook(self):
        def hook(d):
            if datetime.now() - self._last_update < self.update_interval:
                return

            status = d.get('status', '')
            if status == 'downloading':
                downloaded = d.get('downloaded_bytes', 0)
                total = d.get('total_bytes', 0) or d.get('total_bytes_estimate', 0)
                
                if total > 0:
                    progress = (downloaded / total) * 100
                    asyncio.create_task(self.manager.broadcast_to_client(
                        self.client_id,
                        json.dumps({
                            'video_id': self.video_id,
                            'status': 'downloading',
                            'progress': progress,
                            'speed': d.get('speed', 0),
                            'eta': d.get('eta', 0)
                        })
                    ))
            
            elif status == 'finished':
                asyncio.create_task(self.manager.broadcast_to_client(
                    self.client_id,
                    json.dumps({
                        'video_id': self.video_id,
                        'status': 'finished',
                        'progress': 100
                    })
                ))
            
            self._last_update = datetime.now()
        
        return hook

class WebSocketManager:
    def __init__(self):
        self.active_connections: Dict[str, List[WebSocket]] = {}
        self._lock = asyncio.Lock()

    async def connect(self, websocket: WebSocket, client_id: str):
        await websocket.accept()
        async with self._lock:
            if client_id not in self.active_connections:
                self.active_connections[client_id] = []
            self.active_connections[client_id].append(websocket)
        logger.info(f"New WebSocket connection established for client {client_id}")

    async def disconnect(self, websocket: WebSocket, client_id: str):
        async with self._lock:
            if client_id in self.active_connections:
                try:
                    self.active_connections[client_id].remove(websocket)
                    if not self.active_connections[client_id]:
                        del self.active_connections[client_id]
                except ValueError:
                    pass
        logger.info(f"WebSocket connection closed for client {client_id}")

    async def broadcast_to_client(self, client_id: str, message: str):
        if client_id not in self.active_connections:
            return
        
        disconnected = []
        for connection in self.active_connections[client_id]:
            try:
                await connection.send_text(message)
            except Exception as e:
                logger.error(f"Error broadcasting to client {client_id}: {e}")
                disconnected.append(connection)
        
        for conn in disconnected:
            await self.disconnect(conn, client_id)

class CredentialManager:
    def __init__(self):
        self.credentials: Dict[str, Credentials] = {}
        self._lock = asyncio.Lock()

    async def store(self, client_id: str, credentials: Credentials):
        async with self._lock:
            self.credentials[client_id] = credentials

    async def get(self, client_id: str) -> Optional[Credentials]:
        async with self._lock:
            return self.credentials.get(client_id)

    async def remove(self, client_id: str):
        async with self._lock:
            self.credentials.pop(client_id, None)

class AuthManager:
    def __init__(self):
        self.credential_manager = CredentialManager()
        self._refresh_locks = {}

    async def get_valid_credentials(self, client_id: str) -> Optional[Credentials]:
        try:
            creds = await self.credential_manager.get(client_id)
            if not creds:
                logger.debug(f"No credentials found for client_id: {client_id}")
                return None

            # Check if credentials need refresh
            if not creds.valid:
                logger.debug(f"Credentials invalid for client_id: {client_id}, attempting refresh")
                if client_id not in self._refresh_locks:
                    self._refresh_locks[client_id] = asyncio.Lock()
                
                async with self._refresh_locks[client_id]:
                    try:
                        if creds.expired and creds.refresh_token:
                            request = GoogleRequest()
                            creds.refresh(request)
                            await self.credential_manager.store(client_id, creds)
                            logger.debug(f"Successfully refreshed credentials for client_id: {client_id}")
                    except Exception as e:
                        logger.error(f"Failed to refresh credentials: {e}")
                        await self.credential_manager.remove(client_id)
                        return None

            return creds
        except Exception as e:
            logger.error(f"Error in get_valid_credentials: {e}")
            return None

# Initialize managers
manager = WebSocketManager()
credential_manager = CredentialManager()
auth_manager = AuthManager()

# Helper functions
def get_flow():
    try:
        return Flow.from_client_secrets_file(
            CLIENT_SECRETS_FILE,
            scopes=SCOPES,
            redirect_uri=REDIRECT_URI
        )
    except Exception as e:
        logger.error(f"Failed to create OAuth flow: {e}")
        raise HTTPException(status_code=500, detail=f"OAuth configuration error: {str(e)}")

async def get_credentials(request: Request) -> Credentials:
    client_id = request.cookies.get("client_id")
    if not client_id:
        raise HTTPException(status_code=401, detail="No client ID found")
    
    creds = await auth_manager.get_valid_credentials(client_id)
    if not creds:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return creds

async def download_video(url: str, folder: str, video_id: str, client_id: str):
    try:
        progress_manager = ProgressManager(manager, client_id, video_id)
        
        ydl_opts = {
            'outtmpl': os.path.join(folder, '%(title)s.%(ext)s'),
            'format': 'best',
            'progress_hooks': [progress_manager.create_hook()],
            'quiet': True,
            'no_warnings': True,
            'noprogress': False
        }
        
        def download():
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                ydl.download([url])
        
        await asyncio.get_event_loop().run_in_executor(None, download)
        
    except Exception as e:
        logger.error(f"Download error for {video_id}: {e}")
        await manager.broadcast_to_client(
            client_id,
            json.dumps({
                'video_id': video_id,
                'status': 'error',
                'error': str(e)
            })
        )

async def fetch_search_videos(youtube, query, category, max_results):
    search_response = await asyncio.get_event_loop().run_in_executor(
        None,
        lambda: youtube.search().list(
            part="id,snippet",
            q=query,
            type="video",
            maxResults=max_results,
            videoCategoryId=category if category else None
        ).execute()
    )
    return [
        f"https://www.youtube.com/watch?v={item['id']['videoId']}" 
        for item in search_response.get('items', [])
    ]

async def fetch_watch_later_videos(youtube, max_results):
    try:
        playlist_response = await asyncio.get_event_loop().run_in_executor(
            None,
            lambda: youtube.playlistItems().list(
                part="contentDetails",
                playlistId="WL",
                maxResults=max_results
            ).execute()
        )
        return [
            f"https://www.youtube.com/watch?v={item['contentDetails']['videoId']}" 
            for item in playlist_response.get('items', [])
        ]
    except HttpError as e:
        if e.resp.status == 404:
            logger.warning("Watch Later playlist not found or empty")
            return []
        raise

async def fetch_unwatched_videos(youtube, max_results):
    activities_response = await asyncio.get_event_loop().run_in_executor(
        None,
        lambda: youtube.activities().list(
            part="contentDetails",
            home=True,
            maxResults=max_results
        ).execute()
    )
    return [
        f"https://www.youtube.com/watch?v={item['contentDetails']['upload']['videoId']}" 
        for item in activities_response.get('items', [])
        if 'upload' in item.get('contentDetails', {})
    ]

# Routes
@app.get("/")
async def root():
    return {"message": "YouTube Downloader API is running"}

@app.get("/auth")
async def auth(request: Request, response: Response):
    try:
        flow = get_flow()
        # Generate client ID
        client_id = os.urandom(16).hex()
        
        # Create state that includes client ID
        state = encode_state(client_id)
        
        authorization_url, _ = flow.authorization_url(
            access_type='offline',
            include_granted_scopes='true',
            prompt='consent',
            state=state
        )
        
        # Set secure cookie with client ID
        response = RedirectResponse(authorization_url)
        response.set_cookie(
            key="client_id",
            value=client_id,
            httponly=True,
            secure=False,  # Set to True in production
            samesite='lax',
            max_age=3600,
            path="/",
            domain="localhost"
        )
        
        return response

    except Exception as e:
        logger.error(f"Auth error: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to initiate authentication")
        
@app.get("/auth/callback")
async def auth_callback(
    code: str,
    state: str = None,
    request: Request = None
):
    try:
        state_data = decode_state(state) if state else {}
        client_id = state_data.get('client_id')
        
        if not client_id:
            logger.error("No client ID found in state")
            raise HTTPException(status_code=401, detail="No client ID found")

        flow = get_flow()
        flow.fetch_token(code=code)
        credentials = flow.credentials
        
        await credential_manager.store(client_id, credentials)
        
        response = JSONResponse(
            content={"status": "success", "message": "Authentication successful"}
        )
        
        response.set_cookie(
            key="client_id",
            value=client_id,
            httponly=True,
            secure=False,  # Set to True in production
            samesite='lax',
            max_age=3600,
            path="/",
            domain="localhost"
        )
        
        return response
    except Exception as e:
        logger.error(f"Callback error: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/auth/check")
async def auth_check(request: Request):
    try:
        client_id = request.cookies.get("client_id")
        if not client_id:
            logger.debug("No client_id in cookies during auth check")
            return JSONResponse(
                status_code=401,
                content={"status": "error", "message": "Not authenticated"}
            )
        
        creds = await auth_manager.get_valid_credentials(client_id)
        if not creds or not creds.valid:
            logger.debug(f"Invalid credentials for client_id: {client_id}")
            return JSONResponse(
                status_code=401,
                content={"status": "error", "message": "Invalid or expired credentials"}
            )
        
        return JSONResponse(
            content={"status": "success", "message": "Authenticated"}
        )
    except Exception as e:
        logger.error(f"Auth check error: {str(e)}")
        return JSONResponse(
            status_code=500,
            content={"status": "error", "message": str(e)}
        )

@app.get("/user/profile")
async def get_user_profile(request: Request, credentials: Credentials = Depends(get_credentials)):
    try:
        userinfo_request = requests.Request()
        
        try:
            if credentials.id_token:
                id_info = id_token.verify_oauth2_token(
                    credentials.id_token,
                    userinfo_request,
                    credentials.client_id
                )
                return {
                    "name": id_info.get("name", "Unknown User"),
                    "picture": id_info.get("picture", ""),
                    "email": id_info.get("email", "")
                }
        except Exception as e:
            logger.warning(f"Could not get profile from id_token: {e}")
        
        youtube = googleapiclient.discovery.build("youtube", "v3", credentials=credentials)
        channels_response = youtube.channels().list(
            part="snippet",
            mine=True
        ).execute()
        
        if channels_response["items"]:
            channel = channels_response["items"][0]["snippet"]
            return {
                "name": channel.get("title", "Unknown User"),
                "picture": channel.get("thumbnails", {}).get("default", {}).get("url", ""),
                "email": ""
            }
        
        return {"name": "Unknown User", "picture": "", "email": ""}
            
    except Exception as e:
        logger.error(f"Profile fetch error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.websocket("/progress")
async def websocket_endpoint(websocket: WebSocket, request: Request):
    client_id = request.cookies.get("client_id")
    if not client_id:
        await websocket.close(code=1008, reason="No client ID found")
        return
    
    await manager.connect(websocket, client_id)
    try:
        while True:
            data = await websocket.receive_text()
            logger.info(f"Received WebSocket message from client {client_id}: {data}")
    except WebSocketDisconnect:
        await manager.disconnect(websocket, client_id)
    except Exception as e:
        logger.error(f"WebSocket error for client {client_id}: {e}")
        await manager.disconnect(websocket, client_id)

@app.post("/start-download")
async def start_download(
    request: Request,
    download_request: DownloadRequest,
    credentials: Credentials = Depends(get_credentials)
):
    client_id = request.cookies.get("client_id")
    if not client_id:
        raise HTTPException(status_code=401, detail="No client ID found")

    try:
        os.makedirs(download_request.folder, exist_ok=True)
        
        youtube = googleapiclient.discovery.build("youtube", "v3", credentials=credentials)
        video_urls = []

        if download_request.query:
            search_response = await asyncio.get_event_loop().run_in_executor(
                None,
                lambda: youtube.search().list(
                    part="id,snippet",
                    q=download_request.query,
                    type="video",
                    maxResults=download_request.numVideos,
                    videoCategoryId=download_request.category if download_request.category else None
                ).execute()
            )
            video_urls.extend([
                f"https://www.youtube.com/watch?v={item['id']['videoId']}" 
                for item in search_response.get('items', [])
            ])

        if download_request.useWatchLater:
            playlist_response = await asyncio.get_event_loop().run_in_executor(
                None,
                lambda: youtube.playlistItems().list(
                    part="contentDetails",
                    playlistId="WL",
                    maxResults=download_request.numVideos
                ).execute()
            )
            video_urls.extend([
                f"https://www.youtube.com/watch?v={item['contentDetails']['videoId']}" 
                for item in playlist_response.get('items', [])
            ])

        if download_request.useUnwatched:
            subscription_response = await asyncio.get_event_loop().run_in_executor(
                None,
                lambda: youtube.activities().list(
                    part="contentDetails",
                    home=True,
                    maxResults=download_request.numVideos
                ).execute()
            )
            video_urls.extend([
                f"https://www.youtube.com/watch?v={item['contentDetails']['upload']['videoId']}" 
                for item in subscription_response.get('items', [])
                if 'upload' in item.get('contentDetails', {})
            ])

        # Start downloads
        tasks = []
        for i, url in enumerate(video_urls):
            video_id = f"video_{i+1}"
            task = asyncio.create_task(
                download_video(url, download_request.folder, video_id, client_id)
            )
            tasks.append(task)

        # Wait for all downloads to complete
        await asyncio.gather(*tasks)

        return {"message": "Downloads completed", "total_videos": len(video_urls)}

    except Exception as e:
        logger.error(f"Download start error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
