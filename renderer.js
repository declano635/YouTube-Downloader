let isAuthenticated = false;
let isWebSocketConnected = false;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_INTERVAL = 5000;
const MAX_VIDEOS = 50;
let reconnectTimeout = null;
let authCheckInterval = null;

// Initialize UI state
function initializeUI() {
    const controls = [
        "query",
        "category",
        "numVideos",
        "useRecommended",
        "useWatchLater",
        "useUnwatched",
        "selectFolder",
        "startDownload"
    ];
    
    controls.forEach(id => {
        const element = document.getElementById(id);
        if (element) {
            element.disabled = !isAuthenticated;
        }
    });

    // Update auth button visibility
    const authButton = document.getElementById("authButton");
    if (authButton) {
        authButton.style.display = isAuthenticated ? "none" : "block";
    }

    // Update profile visibility
    const profile = document.getElementById("profile");
    if (profile) {
        profile.style.display = isAuthenticated ? "block" : "none";
    }
}

// Enhanced WebSocket connection management
function connectWebSocket() {
    if (!isWebSocketConnected && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        window.electron.connectWebSocket();
        isWebSocketConnected = true;
        reconnectAttempts++;
    } else if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        document.getElementById('status').innerText = 'Status: Failed to establish WebSocket connection after multiple attempts';
        cleanupWebSocket();
    }
}

function handleWebSocketReconnect() {
    isWebSocketConnected = false;
    if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
    }
    reconnectTimeout = setTimeout(connectWebSocket, RECONNECT_INTERVAL);
}

function cleanupWebSocket() {
    if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
        reconnectTimeout = null;
    }
    reconnectAttempts = 0;
    isWebSocketConnected = false;
    window.electron.disconnectWebSocket();
}

// Function to cleanup auth check interval
function cleanupAuthCheck() {
    if (authCheckInterval) {
        clearInterval(authCheckInterval);
        authCheckInterval = null;
    }
}

// Enhanced error handling
function showError(message) {
    const status = document.getElementById("status");
    status.innerText = `Status: Error - ${message}`;
    status.className = 'error';
}

function showSuccess(message) {
    const status = document.getElementById("status");
    status.innerText = `Status: ${message}`;
    status.className = 'success';
}

// Function to fetch user profile
async function fetchUserProfile() {
    try {
        const response = await fetch('http://localhost:8000/user/profile', {
            method: 'GET',
            credentials: 'include'
        });
        
        if (response.ok) {
            const profile = await response.json();
            const profilePicture = document.getElementById("profilePicture");
            profilePicture.src = profile.picture || '';
            profilePicture.crossOrigin = "anonymous";
            document.getElementById("profileName").textContent = profile.name || 'User';
            document.getElementById("profile").style.display = "block";
        } else {
            throw new Error('Failed to fetch profile');
        }
    } catch (error) {
        console.error('Failed to fetch profile:', error);
        showError('Failed to load user profile');
    }
}

// Function to validate download parameters
function validateDownloadParams(formData) {
    if (formData.folder === "No folder selected") {
        showError('Please select a folder first');
        return false;
    }

    if (formData.numVideos <= 0 || formData.numVideos > MAX_VIDEOS) {
        showError(`Please enter a valid number of videos (1-${MAX_VIDEOS})`);
        return false;
    }

    if (!formData.query && !formData.useRecommended && !formData.useWatchLater && !formData.useUnwatched) {
        showError('Please enter a search query or select at least one video source');
        return false;
    }

    return true;
}

// Function to update progress UI
function updateProgress(progress) {
    const progressBar = document.getElementById("progressBar");
    const progressText = document.getElementById("progressText");
    
    if (progress.status === "downloading") {
        const percent = progress.progress.toFixed(1);
        progressBar.style.width = `${percent}%`;
        progressText.innerText = `${percent}%`;
        
        let statusText = `Downloading video ${progress.video_id}...`;
        if (progress.speed) {
            const speed = (progress.speed / 1024 / 1024).toFixed(2);
            statusText += ` Speed: ${speed} MB/s`;
        }
        if (progress.eta) {
            statusText += ` ETA: ${progress.eta}s`;
        }
        
        document.getElementById("status").innerText = `Status: ${statusText}`;
    } else if (progress.status === "finished") {
        progressBar.style.width = "100%";
        progressText.innerText = "100%";
        showSuccess('Download Complete!');
    } else if (progress.status === "error") {
        showError(progress.error);
    }
}

// Event Listeners
document.getElementById("authButton").addEventListener("click", async () => {
    try {
        document.getElementById("status").innerText = "Status: Starting authentication...";
        window.electron.startAuth();

        cleanupAuthCheck();
        
        const authCheck = new Promise((resolve, reject) => {
            let attempts = 0;
            const maxAttempts = 30; // 30 seconds timeout

            authCheckInterval = setInterval(async () => {
                try {
                    attempts++;
                    if (attempts > maxAttempts) {
                        clearInterval(authCheckInterval);
                        reject(new Error('Authentication timed out'));
                        return;
                    }

                    const response = await fetch('http://localhost:8000/auth/check', {
                        method: 'GET',
                        credentials: 'include',
                        headers: {
                            'Accept': 'application/json'
                        }
                    });
                    
                    if (response.ok) {
                        const data = await response.json();
                        if (data.status === 'success') {
                            resolve(data);
                            cleanupAuthCheck();
                        }
                    }
                } catch (error) {
                    console.error('Auth check error:', error);
                }
            }, 1000);
            
            setTimeout(() => {
                cleanupAuthCheck();
                reject(new Error('Authentication timed out'));
            }, 120000);
        });
        
        await authCheck;
        
        isAuthenticated = true;
        showSuccess('Authentication successful');
        await fetchUserProfile();
        initializeUI();
        connectWebSocket();
        
    } catch (error) {
        console.error('Auth error:', error);
        showError(error.message);
        cleanupAuthCheck();
    }
});

document.getElementById("selectFolder").addEventListener("click", async () => {
    const folderPath = await window.electron.selectFolder();
    if (folderPath) {
        document.getElementById("folderPath").innerText = folderPath;
    }
});

document.getElementById("startDownload").addEventListener("click", async () => {
    const formData = {
        query: document.getElementById("query").value.trim(),
        category: document.getElementById("category").value,
        numVideos: parseInt(document.getElementById("numVideos").value),
        folder: document.getElementById("folderPath").innerText,
        useRecommended: document.getElementById("useRecommended").checked,
        useWatchLater: document.getElementById("useWatchLater").checked,
        useUnwatched: document.getElementById("useUnwatched").checked
    };
    
    if (!validateDownloadParams(formData)) {
        return;
    }
    
    try {
        document.getElementById("status").innerText = "Status: Starting download...";
        document.getElementById("startDownload").disabled = true;
        
        connectWebSocket();
        window.electron.startDownload();
        
        const response = await fetch("http://localhost:8000/start-download", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            credentials: 'include',
            body: JSON.stringify(formData),
        });
        
        if (!response.ok) {
            throw new Error(`Server error: ${response.status}`);
        }
        
        const result = await response.json();
        showSuccess(result.message);
    } catch (error) {
        console.error("Download error:", error);
        showError(error.message);
    } finally {
        document.getElementById("startDownload").disabled = false;
    }
});

// WebSocket event listeners
window.electron.onWebSocketMessage((progress) => {
    updateProgress(progress);
    reconnectAttempts = 0;
});

window.electron.onWebSocketError((error) => {
    console.error('WebSocket error:', error);
    showError(`WebSocket connection error`);
    handleWebSocketReconnect();
});

window.electron.onWebSocketClose(() => {
    console.log('WebSocket closed');
    if (isAuthenticated) {
        handleWebSocketReconnect();
    } else {
        cleanupWebSocket();
    }
});

// Initialize UI on page load
document.addEventListener("DOMContentLoaded", () => {
    initializeUI();
    
    // Check if already authenticated
    fetch('http://localhost:8000/auth/check', {
        method: 'GET',
        credentials: 'include'
    })
    .then(response => response.json())
    .then(data => {
        if (data.status === 'success') {
            isAuthenticated = true;
            initializeUI();
            fetchUserProfile();
            connectWebSocket();
        }
    })
    .catch(console.error);
});

// Cleanup on page unload
window.addEventListener("beforeunload", () => {
    cleanupWebSocket();
    cleanupAuthCheck();
    window.electron.removeAllListeners();
});
