/**
 * VINCENT TAILORS - Customer Tracker App
 * 
 * IMPORTANT: Replace CLIENT_ID with your specific Google Cloud Client ID.
 */

// --- CONFIGURATION ---
const CLIENT_ID = '634015940786-k50ahjkg605csqrdik4tg3sl82lrss0a.apps.googleusercontent.com';
const API_KEY = '';
const SCOPES = 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email';

// Spreadsheet ID will be found or created dynamically.
let SPREADSHEET_ID = localStorage.getItem('vt_spreadsheet_id') || null;
const DB_FILENAME = "VincentTailorsDB";
const MASTER_FOLDER_NAME = "Vincent Tailors Customer Photos";

// --- STATE ---
let tokenClient;
let gapiInited = false;
let gisInited = false;
let isAuthenticated = false;
let allCustomers = []; // Local cache
let isFetching = false;

// --- DOM ELEMENTS ---
const authOverlay = document.getElementById('auth-overlay');
const authorizeButton = document.getElementById('authorize_button');
const authStatus = document.getElementById('auth-status');
const appContainer = document.getElementById('app-container');

// --- INITIALIZATION ---

function gapiLoaded() {
    gapi.load('client', intializeGapiClient);
}

async function intializeGapiClient() {
    await gapi.client.load('sheets', 'v4');
    await gapi.client.load('drive', 'v3');
    gapiInited = true;
    checkAuthReady();
}

function gisLoaded() {
    tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID,
        scope: SCOPES,
        callback: '',
    });
    gisInited = true;
    checkAuthReady();
}

function checkAuthReady() {
    if (gapiInited && gisInited) {
        authorizeButton.classList.remove('hidden');
        authStatus.innerText = "Ready to connect.";

        // Auto-login logic
        // We check if the user was previously logged in (flag)
        // We do NOT check expiry strictly here, because even if the access token expired,
        // we might be able to get a NEW one silently if the user is signed into Google.
        const isLoggedIn = localStorage.getItem('vt_is_logged_in') === 'true';

        if (isLoggedIn) {
            console.log("Attempting silent login...");
            authStatus.innerText = "Restoring session...";
            authorizeButton.classList.add('hidden');

            // Try silent login
            try {
                tokenClient.callback = handleAuthResponse;
                const storedEmail = localStorage.getItem('vt_user_email');
                const config = { prompt: 'none' };
                if (storedEmail) {
                    config.login_hint = storedEmail;
                }
                tokenClient.requestAccessToken(config);
            } catch (e) {
                console.warn("Silent login failed", e);
                authorizeButton.classList.remove('hidden');
                authStatus.innerText = "Session expired. Please sign in.";
                localStorage.removeItem('vt_is_logged_in');
                localStorage.removeItem('vt_user_email');
            }
        }
    }
}


// --- AUTHENTICATION ---

async function handleAuthResponse(resp) {
    if (resp.error) {
        console.warn("Auth Error or Login Required:", resp);
        if (resp.error === 'interaction_required' || resp.error === 'login_required') {
            authorizeButton.classList.remove('hidden');
            authStatus.innerText = "Please sign in.";
            localStorage.removeItem('vt_token_expiry');
            localStorage.removeItem('vt_is_logged_in'); // Clear persistence flag on failure
            localStorage.removeItem('vt_user_email');
        } else {
            throw (resp);
        }
        return;
    }

    isAuthenticated = true;

    // Store simple expiry (1 hour - buffer) and Persistent Flag
    const expiresIn = (resp.expires_in || 3599) * 1000;
    const expiryTime = Date.now() + expiresIn - 5 * 60 * 1000; // 5 min buffer
    localStorage.setItem('vt_token_expiry', expiryTime);
    localStorage.setItem('vt_is_logged_in', 'true'); // MARK AS LOGGED IN

    // Fix: Set token for GAPI Client
    if (gapi.client) {
        gapi.client.setToken(resp);
    }

    // Fetch and store User Email for next silent login
    try {
        const accessToken = resp.access_token;
        if (accessToken) {
            const userInfoResp = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
                headers: { 'Authorization': `Bearer ${accessToken}` }
            });
            const userInfo = await userInfoResp.json();
            if (userInfo && userInfo.email) {
                console.log("Email stored for silent auth:", userInfo.email);
                localStorage.setItem('vt_user_email', userInfo.email);
            }
        }
    } catch (e) {
        console.warn("Could not fetch user email for hint:", e);
    }

    authOverlay.classList.add('opacity-0', 'pointer-events-none');
    setTimeout(() => {
        authOverlay.classList.add('hidden');
        appContainer.classList.remove('hidden');
    }, 300);

    await ensureDatabaseExists();
}

authorizeButton.onclick = () => {
    tokenClient.callback = handleAuthResponse;
    // Always use empty prompt (or 'select_account') to avoid forced consent screen.
    // If not signed in to Google, it will ask to sign in.
    // If signed in, it will likely just proceed or ask to choose account.
    tokenClient.requestAccessToken({ prompt: '' });
};

// --- DATABASE MANIPULATION (SHEETS) ---

async function ensureDatabaseExists(forceCheck = false) {
    if (!SPREADSHEET_ID || forceCheck) {
        console.log("Searching for database...");
        try {
            const response = await gapi.client.drive.files.list({
                q: `name = '${DB_FILENAME}' and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false`,
                fields: 'files(id, name)',
            });
            const files = response.result.files;
            if (files && files.length > 0) {
                SPREADSHEET_ID = files[0].id;
                console.log("Found existing DB:", SPREADSHEET_ID);
            } else {
                console.log("Creating new DB...");
                const createResp = await gapi.client.sheets.spreadsheets.create({
                    properties: { title: DB_FILENAME },
                    sheets: [{ properties: { title: "Customers" } }]
                });
                SPREADSHEET_ID = createResp.result.spreadsheetId;
                await gapi.client.sheets.spreadsheets.values.update({
                    spreadsheetId: SPREADSHEET_ID,
                    range: "Customers!A1:E1",
                    valueInputOption: "RAW",
                    resource: { values: [["BookID", "Name", "Phone", "PhotoFolderId", "DateCreated"]] }
                });
            }
            localStorage.setItem('vt_spreadsheet_id', SPREADSHEET_ID);
        } catch (err) {
            console.error("Error setting up DB:", err);
            alert("Error connecting to Google Drive. Check console.");
        }
    }
    // Initial Fetch for Search Cache
    await fetchAllCustomers();
}

async function fetchAllCustomers() {
    if (isFetching) return;
    isFetching = true;
    try {
        const response = await gapi.client.sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: 'Customers!A2:E',
        });
        const rows = response.result.values;
        if (rows && rows.length > 0) {
            allCustomers = rows;
        } else {
            allCustomers = [];
        }
        performSearch(); // Update UI after fetch
    } catch (err) {
        console.error("Error fetching customers:", err);
        // Auto-recovery: If 404 (Not Found), it means SPREADSHEET_ID is invalid/deleted
        if (err.status === 404) {
            console.warn("Database not found. Attempting recovery...");
            localStorage.removeItem('vt_spreadsheet_id');
            SPREADSHEET_ID = null;
            isFetching = false; // Reset flag or ensureDatabaseExists won't fetch
            // Avoid infinite loop by not calling if we just tried? 
            // Ideally ensuring DB exists should fix it.
            await ensureDatabaseExists(true);
            return;
        }
    } finally {
        isFetching = false;
    }
}

// --- APP LOGIC ---

// Navigation
// Navigation & Routing (History API)
const viewMap = {
    'view-search': document.getElementById('view-search'),
    'view-add': document.getElementById('view-add'),
    'view-details': document.getElementById('view-details'),
    'view-edit': document.getElementById('view-edit'),
    'view-settings': document.getElementById('view-settings')
};

// Exit Confirmation Modal Strings
const exitModal = document.getElementById('exit-modal');
const exitConfirmBtn = document.getElementById('exit-confirm-btn');
const exitCancelBtn = document.getElementById('exit-cancel-btn');

function navigateTo(viewId, addToHistory = true) {
    // Hide Exit Modal if open (navigation cancels exit intent)
    exitModal.classList.add('hidden');

    // Switch View
    Object.values(viewMap).forEach(el => {
        el.classList.remove('active');
        el.classList.add('hidden');
    });

    // Safety check
    if (!viewMap[viewId]) viewId = 'view-search';

    viewMap[viewId].classList.add('active');
    viewMap[viewId].classList.remove('hidden');

    // Update Bottom Nav Styling
    document.querySelectorAll('.nav-btn').forEach(btn => {
        if (btn.getAttribute('data-target') === viewId) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    });

    if (viewId === 'view-search') document.getElementById('search-input').focus();

    // History Logic
    if (addToHistory) {
        history.pushState({ view: viewId }, "", `#${viewId}`);
    }
}

function handleRouting(event) {
    const state = event.state;
    // If state exists, it means we are navigating within the app history
    if (state && state.view) {
        navigateTo(state.view, false); // Don't push again
    } else {
        // We hit the beginning of history (or null state)
        // This usually means the user pressed "Back" on the initially loaded page.
        // We want to TRAP this if we are effectively at "Home".

        // However, standard browser behavior is tricky.
        // Strategy: When app loads, we replaceState to 'home' and pushState 'home' again?
        // Better Strategy for "Exit Trap":
        // 1. App Loads -> pushState({view: 'view-search'}, "Home", "#home").
        // 2. User presses Back -> popstate event with state null.
        // 3. We show Exit Modal.
        // 4. We pushState again immediately to restore the forward path? Or we stay at null?

        showExitConfirmation();
    }
}

function showExitConfirmation() {
    exitModal.classList.remove('hidden');
    // We need to ensure that if they click "Cancel", we are back in a valid state.
    // If we popped to null to get here, we are technically "outside" our history stack.
    // So "Cancel" should push state back to Home.
}

exitCancelBtn.onclick = () => {
    exitModal.classList.add('hidden');
    // Restore state (effectively "Cancel Exit" -> go back to Home state)
    history.pushState({ view: 'view-search' }, "", "#view-search");
};

exitConfirmBtn.onclick = () => {
    // Ideally, let the browser exit. 
    // Since we are at the end of history (null state), going back again *should* close the app/tab.
    // Or we used history.back() to trigger the exit if we pushed a dummy state.

    // For installed PWA on Android, window.close() might not work.
    // But if we are in the null state, and we do history.back(), it should exit.
    history.back();
    // Fallback
    window.close();
};

window.addEventListener('popstate', handleRouting);

// Initialize Navigation Listeners
document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
        const targetId = btn.getAttribute('data-target');
        if (targetId) navigateTo(targetId);
    });
});

// Initialize App Routing on Load
function initRouter() {
    // Push initial state so we have something to pop FROM
    // We replace the current (null) state with Home, then Push Home?
    // No, standard PWA pattern:
    // Load -> Replace State (Home). Then if user navigates, Push State.
    // Problem: Back button on Home should Exit.
    // If we want to TRAP exit, we need: [Null] -> [Home].
    // Back from Home -> [Null] -> Trap.

    // Check if we already have state (reload)
    if (!history.state) {
        // Initial Load
        history.replaceState(null, "", null); // Ensure root is null
        history.pushState({ view: 'view-search' }, "", "#view-search"); // Push Home
    } else {
        // Reloaded page with state
        navigateTo(history.state.view, false);
    }
}

// Call initRouter later in initialization or end of script
setTimeout(initRouter, 100);

// Update Back Buttons to use History
document.getElementById('back-btn').onclick = () => {
    history.back();
};

// Update AddForm Success Navigation
// Found in addForm.onsubmit: document.querySelector('[data-target="view-search"]').click(); 
// This triggers the click listener => navigateTo => pushState. Use direct navigateTo?
// Better to search code and replace manual clicks.

// Same for Cancel Edit: showCustomerDetails calls view setup directly. 
// We should refactor to use routing or ensure consistency. 
// For now, let's just make sure the Back Button is the primary fix.


// Search
const searchBtn = document.getElementById('search-btn');
const searchInput = document.getElementById('search-input');
const searchResults = document.getElementById('search-results');

function performSearch() {
    const query = searchInput.value.trim().toLowerCase();

    // If no query, show all customers (latest first)
    let matches;
    if (!query) {
        matches = [...allCustomers].reverse(); // Copy and reverse
    } else {
        matches = allCustomers.filter(row => {
            const phone = row[2] ? row[2].toString() : "";
            const name = row[1] ? row[1].toString().toLowerCase() : "";
            const id = row[0] ? row[0].toString().toLowerCase() : "";
            return phone.includes(query) || name.includes(query) || id.includes(query);
        });
        // If searching, maybe we still want latest matches first?
        matches.reverse();
    }

    searchResults.innerHTML = '';
    if (matches.length === 0) {
        searchResults.innerHTML = '<div class="text-center text-slate-500">No customers found.</div>';
        return;
    }

    matches.forEach(row => {
        const card = document.createElement('div');
        // Added active:scale-98 for click feedback and corrected hover color
        card.className = "bg-slate-800 p-4 rounded-xl border border-white/5 flex justify-between items-center hover:bg-slate-700 cursor-pointer transition active:scale-95 group";
        card.innerHTML = `
            <div>
                <h3 class="font-bold text-lg text-white group-hover:text-indigo-400 transition-colors">${row[0]}</h3>
                <p class="text-slate-400 text-sm">${row[1]}</p>
            </div>
            <div class="text-right">
                <p class="text-indigo-400 font-mono group-hover:text-indigo-300 transition-colors">${row[2]}</p>
            </div>
        `;

        card.onclick = () => {
            card.classList.add('bg-slate-700');
            setTimeout(() => card.classList.remove('bg-slate-700'), 150);
            showCustomerDetails(row);
        };

        searchResults.appendChild(card);
    });
}
searchBtn.onclick = performSearch;
searchInput.addEventListener('input', performSearch);
// Show list on load
setTimeout(performSearch, 500); // Small delay to let fetch finish if it's fast, calling it again in fetchAllCustomers logic is better


// Add Customer
const addForm = document.getElementById('add-customer-form');
addForm.onsubmit = async (e) => {
    e.preventDefault();
    const btn = addForm.querySelector('button');
    const originalText = btn.innerText;
    btn.disabled = true;
    btn.innerText = "Saving...";

    const id = document.getElementById('inp-book-id').value.toUpperCase().trim();
    const name = document.getElementById('inp-name').value;
    const phone = document.getElementById('inp-phone').value;
    const date = new Date().toLocaleDateString('en-GB');

    // Check for duplicate ID
    const exists = allCustomers.some(row => row[0] && row[0].toString().trim().toUpperCase() === id);
    if (exists) {
        alert(`Error: Customer ID "${id}" is already available!`);
        btn.disabled = false;
        btn.innerText = originalText;
        return;
    }

    const newRow = [id, name, phone, "", date];
    allCustomers.push(newRow);

    try {
        await gapi.client.sheets.spreadsheets.values.append({
            spreadsheetId: SPREADSHEET_ID,
            range: "Customers!A:E",
            valueInputOption: "USER_ENTERED",
            resource: { values: [newRow] }
        });
        alert("Customer Saved!");
        addForm.reset();
        document.querySelector('[data-target="view-search"]').click();
    } catch (err) {
        console.error(err);
        alert("Error saving: " + err.message);
        allCustomers.pop();
    } finally {
        btn.disabled = false;
        btn.innerText = originalText;
    }
};

// Customer Details
let currentCustomerRow = null;

function showCustomerDetails(row) {
    currentCustomerRow = row;
    document.getElementById('det-book-id').innerText = row[0];
    document.getElementById('det-name').innerText = row[1];
    document.getElementById('det-phone').innerText = row[2];
    document.getElementById('det-phone-link').href = `tel:${row[2]}`;
    document.getElementById('det-date-created').innerText = row[4] || "Unknown";

    // Setup Delete Button
    const deleteBtn = document.getElementById('delete-customer-btn');
    deleteBtn.onclick = () => deleteCustomer(row);

    // Setup Edit Button
    document.getElementById('edit-customer-btn').onclick = () => showEditView(row);

    // Using navigateTo without pushing state if we don't want deep linking to specific customer yet?
    // Actually, good UX is: Click Customer -> Push State (Details). Back -> Search.
    // But our current navigateTo expects a viewId. 'view-details' is a view. 
    // So we should navigateTo('view-details').
    // BUT we need to set the DOM content first.

    // Ideally: set content, then navigate.
    navigateTo('view-details');

    loadPhotos(row[3]);
}

// Back Button is already handled globally by history.back logic injected previously
// But wait, the standard router back-btn logic replaced the specific onclick.
// document.getElementById('back-btn').onclick... was replaced? 
// No, I added the listener in the big block. I need to remove the OLD listener if it conflicts.
// The old listener was: document.getElementById('back-btn').onclick = ... 
// I replaced lines 229, but the old back-btn listener was at line 376 (original).
// I should remove/update that one too.

// Logout
document.getElementById('logout-btn').onclick = () => {
    const confirmLogout = confirm("Are you sure you want to sign out?");
    if (confirmLogout) {
        // Revoke if possible, else just reload to clear memory state
        if (google && google.accounts && google.accounts.oauth2) {
            // Access token revocation is good practice but might require the token
            // For simple use case, we re-prompt on next login by not restoring session automatically
        }
        // Simple reload to clear auth state from memory
        localStorage.removeItem('vt_is_logged_in');
        localStorage.removeItem('vt_token_expiry');
        localStorage.removeItem('vt_user_email');
        window.location.reload();
    }
};

// --- PHOTO MANAGEMENT ---

const grid = document.getElementById('photo-grid');

async function loadPhotos(folderId) {
    if (!folderId) {
        grid.innerHTML = '<div class="col-span-2 text-center text-slate-500 py-8 border border-white/5 border-dashed rounded-xl">No photos yet. Upload one to start.</div>';
        return;
    }

    grid.innerHTML = '<div class="col-span-2 text-center text-slate-500 py-8">Loading photos...</div>';

    try {
        const response = await gapi.client.drive.files.list({
            q: `'${folderId}' in parents and trashed = false`,
            fields: 'files(id, name, thumbnailLink, webContentLink)',
        });
        const files = response.result.files;
        grid.innerHTML = '';

        if (files && files.length > 0) {
            files.forEach(file => {
                // Generate high-res URL by modifying thumbnailLink (remove size limit)
                const highResUrl = file.thumbnailLink ? file.thumbnailLink.replace(/=s\d+/, '=s2000') : file.webContentLink;

                const imgContainer = document.createElement('div');
                imgContainer.className = "relative aspect-square rounded-xl overflow-hidden bg-slate-800 group";

                imgContainer.innerHTML = `
                <img src="${file.thumbnailLink}" class="w-full h-full object-cover">
                <!-- Overlay to handle click -->
                <div class="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition cursor-zoom-in photo-overlay"></div>
                
                <button class="delete-btn absolute top-1 right-1 bg-red-500/80 text-white p-1 rounded-full opacity-0 group-hover:opacity-100 transition shadow-sm z-10" title="Delete Photo">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
                </button>
                `;

                // Add Event Listeners Programmatically
                const overlay = imgContainer.querySelector('.photo-overlay');
                overlay.addEventListener('click', () => openImageViewer(highResUrl));

                const delBtn = imgContainer.querySelector('.delete-btn');
                delBtn.addEventListener('click', (e) => {
                    e.stopPropagation(); // Stop click from propagating to overlay if needed
                    deletePhoto(file.id, folderId);
                });

                grid.appendChild(imgContainer);
            });
        } else {
            grid.innerHTML = '<div class="col-span-2 text-center text-slate-500 py-8 border border-white/5 border-dashed rounded-xl">Folder empty.</div>';
        }
    } catch (err) {
        console.error(err);
        grid.innerText = "Error loading photos: " + (err.message || "Unknown error");
    }
}

async function getOrCreateMasterFolder() {
    let masterId = localStorage.getItem('vt_master_folder_id');
    if (!masterId) {
        try {
            const response = await gapi.client.drive.files.list({
                q: `name = '${MASTER_FOLDER_NAME}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
                fields: 'files(id, name)',
            });

            if (response.result.files && response.result.files.length > 0) {
                masterId = response.result.files[0].id;
            } else {
                const folderMeta = {
                    'name': MASTER_FOLDER_NAME,
                    'mimeType': 'application/vnd.google-apps.folder'
                };
                const createResp = await gapi.client.drive.files.create({
                    resource: folderMeta,
                    fields: 'id'
                });
                masterId = createResp.result.id;
            }
            localStorage.setItem('vt_master_folder_id', masterId);
        } catch (err) {
            console.error("Error organizing folders:", err);
            return null;
        }
    }
    return masterId;
}

// --- PHOTO UPLOAD & CROP ---

// File Input Change (Trigger Crop Modal)
const fileInput = document.getElementById('file-input');
const cropModal = document.getElementById('crop-modal');
const cropImage = document.getElementById('crop-image');
let cropper = null;
let selectedFile = null;

fileInput.onchange = function (e) {
    if (e.target.files && e.target.files.length > 0) {
        selectedFile = e.target.files[0];
        const reader = new FileReader();
        reader.onload = function (evt) {
            cropImage.src = evt.target.result;
            showCropModal();
        };
        reader.readAsDataURL(selectedFile);
    }
};

// Fix: Trigger file input when the formatted button is clicked
document.getElementById('upload-photo-btn').onclick = () => {
    fileInput.click();
};

function showCropModal() {
    cropModal.classList.remove('hidden');
    // Initialize Cropper
    if (cropper) cropper.destroy();
    cropper = new Cropper(cropImage, {
        aspectRatio: NaN, // Free crop
        viewMode: 1,
    });
}

function hideCropModal() {
    cropModal.classList.add('hidden');
    if (cropper) {
        cropper.destroy();
        cropper = null;
    }
    fileInput.value = ''; // Reset input
}

document.getElementById('close-crop-btn').onclick = hideCropModal;

document.getElementById('confirm-crop-btn').onclick = () => {
    if (!cropper) return;
    cropper.getCroppedCanvas().toBlob((blob) => {
        // Pass the blobed image to upload
        uploadPhoto(blob, selectedFile.name);
        hideCropModal();
    });
};


async function uploadPhoto(fileOrBlob, filename = "photo.jpg") {
    if (!currentCustomerRow) return;
    let folderId = currentCustomerRow[3];

    const statusDiv = document.createElement('div');
    statusDiv.className = "fixed top-4 right-4 bg-indigo-600 text-white px-4 py-2 rounded shadow-lg z-50 animate-pulse";
    statusDiv.innerText = "Uploading...";
    document.body.appendChild(statusDiv);

    try {
        // 1. Ensure Customer Folder Exists
        if (!folderId) {
            const masterFolderId = await getOrCreateMasterFolder();
            const folderMeta = {
                'name': `${currentCustomerRow[0]} - ${currentCustomerRow[1]}`,
                'mimeType': 'application/vnd.google-apps.folder'
            };
            if (masterFolderId) {
                folderMeta.parents = [masterFolderId];
            }
            const folderResp = await gapi.client.drive.files.create({
                resource: folderMeta,
                fields: 'id'
            });
            folderId = folderResp.result.id;
            await updateSheetWithFolderId(currentCustomerRow[0], folderId);
            currentCustomerRow[3] = folderId;
        }

        // 2. Upload File
        const metadata = {
            'name': filename,
            'parents': [folderId]
        };

        const accessToken = gapi.client.getToken() ? gapi.client.getToken().access_token : null;
        if (!accessToken) throw new Error("No access token. Sign in again.");

        const form = new FormData();
        form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
        form.append('file', fileOrBlob);

        await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
            method: 'POST',
            headers: new Headers({ 'Authorization': 'Bearer ' + accessToken }),
            body: form
        });

        loadPhotos(folderId);

    } catch (err) {
        console.error(err);
        alert("Upload failed: " + err.message);
    } finally {
        statusDiv.remove();
    }
}

async function deletePhoto(fileId, folderId) {
    if (!confirm("Delete this photo permanently?")) return;
    if (event) {
        event.stopPropagation();
        event.preventDefault();
    }

    try {
        const accessToken = gapi.client.getToken() ? gapi.client.getToken().access_token : null;
        if (!accessToken) throw new Error("No token");

        await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
            method: 'DELETE',
            headers: new Headers({ 'Authorization': 'Bearer ' + accessToken })
        });

        loadPhotos(folderId);
    } catch (err) {
        console.error(err);
        alert("Error deleting photo: " + err.message);
    }
}

async function updateSheetWithFolderId(bookId, folderId) {
    // Find row again to be safe
    const response = await gapi.client.sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: 'Customers!A:A',
    });
    const ids = response.result.values;
    let rowIndex = -1;
    if (ids) {
        for (let i = 0; i < ids.length; i++) {
            if (ids[i][0] === bookId) {
                rowIndex = i + 1; // 1-based index
                break;
            }
        }
    }

    if (rowIndex !== -1) {
        await gapi.client.sheets.spreadsheets.values.update({
            spreadsheetId: SPREADSHEET_ID,
            range: `Customers!D${rowIndex}`,
            valueInputOption: "RAW",
            resource: { values: [[folderId]] }
        });
    }
}

// --- DELETE & EDIT CUSTOMER ---

async function deleteCustomer(row) {
    const bookId = row[0];
    const name = row[1];
    if (!confirm(`Are you sure you want to delete ${name} (${bookId})?\nThis action cannot be undone.`)) return;

    const btn = document.getElementById('delete-customer-btn');
    const originalText = btn.innerText;
    btn.innerText = "Deleting...";
    btn.disabled = true;

    try {
        // 1. Find the exact row index
        const response = await gapi.client.sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: 'Customers!A:A',
        });
        const ids = response.result.values;
        let rowIndex = -1;
        if (ids) {
            for (let i = 0; i < ids.length; i++) {
                if (ids[i][0] === bookId) {
                    rowIndex = i; // 0-based index for logic
                    break;
                }
            }
        }

        if (rowIndex === -1) throw new Error("Customer row not found in database.");

        // 2. Find the Sheet ID
        const metaResp = await gapi.client.sheets.spreadsheets.get({
            spreadsheetId: SPREADSHEET_ID,
            fields: 'sheets(properties(sheetId,title))'
        });
        const sheets = metaResp.result.sheets;

        let sheetId;
        // Search case-insensitive
        const customerSheet = sheets ? sheets.find(s => s.properties.title.trim().toLowerCase() === 'customers') : null;

        if (customerSheet) {
            sheetId = customerSheet.properties.sheetId;
            // CHECK if sheetId is undefined (which might happen if it's 0 and API omits it? unlikely but possible)
            if (sheetId === undefined || sheetId === null) {
                console.warn("Sheet ID is undefined/null in metadata, assuming 0.");
                sheetId = 0;
            }
            console.log(`Found 'Customers' sheet. ID: ${sheetId}`);
        } else {
            // Debugging: Show what we found
            const currentSheetNames = sheets ? sheets.map(s => `${s.properties.title} [${s.properties.sheetId}]`).join(', ') : "None";
            alert(`Debug Error: Could not find 'Customers' sheet.\nAvailable sheets: ${currentSheetNames}`);

            // Fallback: If only one sheet exists, use it.
            if (sheets && sheets.length === 1) {
                console.warn("Exact 'Customers' sheet not found, using the only available sheet:", sheets[0].properties.title);
                sheetId = sheets[0].properties.sheetId;
            } else {
                console.error("Available sheets:", sheets);
                throw new Error("Could not identify the 'Customers' sheet. See alert.");
            }
        }

        // Final Safety Check
        if (sheetId === undefined || sheetId === null) {
            alert("Critical Error: Sheet ID is undefined before deletion.");
            throw new Error("Sheet ID unresolved.");
        }

        console.log(`Executing deleteDimension on SheetID: ${sheetId} for RowIndex: ${rowIndex}`);

        // 3. Delete the row (Try physical deletion first)
        try {
            // Check sheetId again just to be safe before calling API
            if (sheetId === undefined || sheetId === null) {
                sheetId = 0; // Try default
            }

            await gapi.client.sheets.spreadsheets.batchUpdate({
                spreadsheetId: SPREADSHEET_ID,
                resource: {
                    requests: [{
                        deleteDimension: {
                            range: {
                                sheetId: sheetId,
                                dimension: "ROWS",
                                startIndex: rowIndex,
                                endIndex: rowIndex + 1
                            }
                        }
                    }]
                }
            });
            console.log("Physical row deletion successful.");
        } catch (deleteErr) {
            console.error("Physical deletion failed, attempting fallback (clear row).", deleteErr);
            // Fallback: Clear the row content using A1 notation (Sheet ID agnostic!)
            // rowIndex is 0-based. A1 notation is 1-based.
            const a1Row = rowIndex + 1;
            await gapi.client.sheets.spreadsheets.values.clear({
                spreadsheetId: SPREADSHEET_ID,
                range: `Customers!A${a1Row}:Z${a1Row}`
            });
            console.log(`Fallback: Cleared content of row ${a1Row}`);
            alert("Note: Optimization failed, but customer data was cleared successfully.");
        }

        // 4. Trash the photo folder
        const folderId = row[3];
        if (folderId) {
            try {
                await gapi.client.drive.files.update({
                    fileId: folderId,
                    resource: { trashed: true }
                });
            } catch (ignore) { }
        }
    } finally {
        btn.innerText = originalText;
        btn.disabled = false;
    }
}

function showEditView(row) {
    document.getElementById('edit-book-id').value = row[0];
    document.getElementById('edit-name').value = row[1];
    document.getElementById('edit-phone').value = row[2];

    document.querySelectorAll('.view-section').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.view-section').forEach(el => el.classList.add('hidden'));
    document.getElementById('view-edit').classList.remove('hidden');
    document.getElementById('view-edit').classList.add('active');
}

document.getElementById('cancel-edit-btn').onclick = () => {
    showCustomerDetails(currentCustomerRow);
};

const editForm = document.getElementById('edit-customer-form');
editForm.onsubmit = async (e) => {
    e.preventDefault();
    if (!currentCustomerRow) return;

    const btn = editForm.querySelector('button[type="submit"]');
    const originalText = btn.innerText;
    btn.disabled = true;
    btn.innerText = "Updating...";

    const bookId = document.getElementById('edit-book-id').value;
    const newName = document.getElementById('edit-name').value;
    const newPhone = document.getElementById('edit-phone').value;

    try {
        const response = await gapi.client.sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: 'Customers!A:A',
        });
        const ids = response.result.values;
        let rowIndex = -1;
        if (ids) {
            for (let i = 0; i < ids.length; i++) {
                if (ids[i][0] === bookId) {
                    rowIndex = i + 1; // 1-based for A1 notation
                    break;
                }
            }
        }

        if (rowIndex === -1) throw new Error("Customer not found in DB");

        await gapi.client.sheets.spreadsheets.values.update({
            spreadsheetId: SPREADSHEET_ID,
            range: `Customers!B${rowIndex}:C${rowIndex}`,
            valueInputOption: "USER_ENTERED",
            resource: { values: [[newName, newPhone]] }
        });

        currentCustomerRow[1] = newName;
        currentCustomerRow[2] = newPhone;

        // --- IMAGE VIEWER ---

        const imageViewerModal = document.getElementById('image-viewer-modal');
        const fullScreenImage = document.getElementById('full-image'); // Corrected ID
        const closeViewerBtn = document.getElementById('close-viewer-btn');

        function openImageViewer(url) {
            if (!fullScreenImage) {
                console.error("Image element not found!");
                return;
            }
            fullScreenImage.src = url;
            imageViewerModal.classList.remove('hidden');
        }

        function closeImageViewer() {
            imageViewerModal.classList.add('hidden');
            fullScreenImage.src = '';
        }

        if (closeViewerBtn) {
            closeViewerBtn.onclick = closeImageViewer;
        }

        if (imageViewerModal) {
            imageViewerModal.onclick = (e) => {
                if (e.target === imageViewerModal) closeImageViewer();
            };
        }


        // Expose functions to global scope for inline HTML handlers
        window.openImageViewer = openImageViewer;
        window.deletePhoto = deletePhoto;

        // Expose functions to global scope for inline HTML handlers
        window.openImageViewer = openImageViewer;
        window.deletePhoto = deletePhoto;
