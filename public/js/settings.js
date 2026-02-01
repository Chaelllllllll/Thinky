// Settings modal helpers - Modular and configurable
let currentSettingsTab = 'profile';

function openSettingsModal(tab = 'profile') {
    const modal = document.getElementById('settingsModal');
    if (!modal) return;
    modal.classList.add('show');
    // Switch to requested tab and populate
    switchSettingsTab(tab);
    populateSettingsForm();
}

function closeSettingsModal() {
    const modal = document.getElementById('settingsModal');
    if (!modal) return;
    modal.classList.remove('show');
}

function switchSettingsTab(tab) {
    currentSettingsTab = tab;
    
    // Update tab buttons
    document.querySelectorAll('.settings-tab').forEach(btn => {
        if (btn.dataset.tab === tab) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    });
    
    // Update content panels
    document.querySelectorAll('.settings-tab-content').forEach(content => {
        if (content.id === `${tab}Tab`) {
            content.classList.add('active');
        } else {
            content.classList.remove('active');
        }
    });
}

async function populateSettingsForm() {
    const modal = document.getElementById('settingsModal');
    if (!modal) return;
    const displayNameEl = modal.querySelector('#displayName');
    const usernameEl = modal.querySelector('#settingsUsername');
    const emailEl = modal.querySelector('#settingsEmail');
    const avatarInput = modal.querySelector('#avatar');
    const avatarPreview = modal.querySelector('#avatarPreview');

    // Reset preview and inputs (show default by default)
    if (avatarPreview) {
        avatarPreview.style.display = 'block';
        avatarPreview.src = '/images/default-avatar.svg';
    }
    if (avatarInput) avatarInput.value = '';

    try {
        const resp = await fetch('/api/auth/me', { credentials: 'include' });
        if (!resp.ok) return window.location.href = '/login';
        const { user } = await resp.json();
        
        // Populate profile fields
        if (displayNameEl) displayNameEl.value = user.display_name || '';
        if (usernameEl) usernameEl.value = user.username || '';
        if (emailEl) emailEl.value = user.email || '';
        
        if (avatarPreview) {
            avatarPreview.src = user.profile_picture_url || '/images/default-avatar.svg';
            avatarPreview.style.display = 'block';
        }
        
        // Load saved preferences from localStorage
        loadSettingsPreferences();
        
    } catch (e) {
        console.error('Failed to load profile', e);
    }

    // Wire up all event handlers
    setupSettingsEventHandlers(modal);
}

function setupSettingsEventHandlers(modal) {
    const avatarInput = modal.querySelector('#avatar');
    const avatarPreview = modal.querySelector('#avatarPreview');
    
    // Avatar upload handler
    if (avatarInput) {
        avatarInput.onchange = (e) => {
            const f = e.target.files[0];
            if (!f) return;
            const reader = new FileReader();
            reader.onload = () => {
                if (avatarPreview) {
                    avatarPreview.src = reader.result;
                    avatarPreview.style.display = 'block';
                }
                const placeholderEl = modal.querySelector('#avatarPlaceholder');
                if (placeholderEl) placeholderEl.style.display = 'none';
            };
            reader.onerror = (err) => {
                console.error('Failed to read avatar file', err);
            };
            reader.readAsDataURL(f);
        };
        
        if (avatarPreview) avatarPreview.onclick = () => avatarInput.click();
        const placeholderEl = modal.querySelector('#avatarPlaceholder');
        if (placeholderEl) {
            placeholderEl.style.cursor = 'pointer';
            placeholderEl.onclick = () => avatarInput.click();
        }
    }

    // Main save button handler
    const saveBtn = modal.querySelector('#saveSettingsBtn');
    if (saveBtn) {
        saveBtn.onclick = async () => {
            await saveCurrentTabSettings();
        };
    }

    // 2FA button handlers
    const enableGoogleAuthBtn = modal.querySelector('#enableGoogleAuthBtn');
    const disableGoogleAuthBtn = modal.querySelector('#disableGoogleAuthBtn');
    const enableEmailAuthBtn = modal.querySelector('#enableEmailAuthBtn');
    const disableEmailAuthBtn = modal.querySelector('#disableEmailAuthBtn');

    if (enableGoogleAuthBtn) {
        enableGoogleAuthBtn.onclick = async () => {
            await enableGoogleAuth();
        };
    }

    if (disableGoogleAuthBtn) {
        disableGoogleAuthBtn.onclick = async () => {
            await disableGoogleAuth();
        };
    }

    if (enableEmailAuthBtn) {
        enableEmailAuthBtn.onclick = async () => {
            await enableEmailAuth();
        };
    }

    if (disableEmailAuthBtn) {
        disableEmailAuthBtn.onclick = async () => {
            await disableEmailAuth();
        };
    }

    // Theme and preference change handlers
    setupPreferenceHandlers(modal);
}

async function saveCurrentTabSettings() {
    const saveBtn = document.querySelector('#saveSettingsBtn');
    if (saveBtn) saveBtn.disabled = true;

    try {
        switch (currentSettingsTab) {
            case 'profile':
                await saveProfileSettings();
                break;
            case 'notifications':
                saveNotificationSettings();
                await window.showModal('Notification preferences saved', 'Success', { small: true });
                break;
            case 'security':
                // Security changes handled by specific buttons
                await window.showModal('Security settings updated', 'Success', { small: true });
                break;
        }
    } catch (e) {
        console.error('Failed to save settings:', e);
        await window.showModal('Failed to save settings. Please try again.', 'Error', { small: true });
    } finally {
        if (saveBtn) saveBtn.disabled = false;
    }
}

async function saveProfileSettings() {
    // Update profile fields including email
    const body = { 
        username: document.getElementById('settingsUsername').value.trim(), 
        display_name: document.getElementById('displayName').value.trim(),
        email: document.getElementById('settingsEmail').value.trim()
    };
    
    const resp = await fetch('/api/auth/me', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    
    if (!resp.ok) {
        const error = await resp.json().catch(() => ({ error: 'Failed to update profile' }));
        throw new Error(error.error || 'Failed to update profile');
    }

    // If avatar selected, upload it. Support both modal (`#avatar`) and standalone settings page (`#avatarInput`).
    const avatarEl = document.getElementById('avatar') || document.getElementById('avatarInput');
    if (avatarEl && avatarEl.files && avatarEl.files[0]) {
        const form = new FormData();
        form.append('avatar', avatarEl.files[0]);
        const aresp = await fetch('/api/auth/me/avatar', {
            method: 'POST',
            credentials: 'include',
            body: form
        });
        if (!aresp.ok) throw new Error('Failed to upload avatar');
    }

    // Refresh UI
    try {
        const me = await fetch('/api/auth/me', { credentials: 'include' });
        if (me.ok) {
            const { user } = await me.json();
            const headerName = document.getElementById('username');
            if (headerName) headerName.textContent = user.username;
            
            // Dispatch event for other parts to react
            try {
                const ev = new CustomEvent('userProfileUpdated', { detail: { user } });
                window.dispatchEvent(ev);
            } catch (e) {}
        }
    } catch (e) {
        // ignore UI refresh errors
    }

    await window.showModal('Profile updated successfully', 'Success', { small: true });
}

async function enableGoogleAuth() {
    try {
        // Request 2FA setup from backend
        const response = await fetch('/api/auth/2fa/google/enable', {
            method: 'POST',
            credentials: 'include'
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Failed to enable Google Authenticator');
        }

        const { secret, qrCode } = await response.json();

        // Create custom modal (not using modalAlerts to avoid scrolling/click issues)
        const overlay = document.createElement('div');
        overlay.id = 'custom2FAModal';
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:99999;';
        
        const modal = document.createElement('div');
        modal.style.cssText = 'background:white;border-radius:16px;padding:24px;max-width:520px;width:94%;box-shadow:0 20px 60px rgba(0,0,0,0.3);max-height:90vh;overflow:auto;-webkit-overflow-scrolling:touch;';
        
        modal.innerHTML = `
            <h3 style="text-align:center;margin-bottom:20px;font-size:1.5rem;">Set Up Google Authenticator</h3>
            <div style="text-align:center;margin-bottom:20px;">
                <img src="${qrCode}" alt="QR Code" style="width:200px;height:200px;border-radius:8px;margin-bottom:12px;">
                <p style="color:var(--dark-gray);font-size:0.9rem;">Scan this QR code with Google Authenticator app</p>
            </div>
            <div style="background:#f5f5f5;padding:12px;border-radius:8px;margin-bottom:16px;text-align:center;font-family:monospace;font-size:0.95rem;word-break:break-all;">
                ${secret}
            </div>
            <p style="color:var(--dark-gray);font-size:0.875rem;margin-bottom:16px;text-align:center;">Or enter this code manually in your authenticator app</p>
            <div style="margin-bottom:16px;">
                <label style="display:block;margin-bottom:8px;font-weight:500;">Enter verification code from app:</label>
                <input type="text" id="verify2FACode" class="form-control" placeholder="000000" maxlength="6" style="text-align:center;font-size:1.5rem;letter-spacing:8px;">
            </div>
            <button id="verify2FAButton" class="btn btn-primary" style="width:100%;padding:12px;font-size:1rem;">Verify & Enable</button>
        `;
        
        overlay.appendChild(modal);
        document.body.appendChild(overlay);
        
        // Close on overlay click
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                overlay.remove();
            }
        });
        
        // Attach handler immediately
        const verifyBtn = document.getElementById('verify2FAButton');
        const codeInput = document.getElementById('verify2FACode');
        
        console.log('Custom modal created, elements:', { verifyBtn, codeInput });
        
        if (verifyBtn && codeInput) {
            verifyBtn.addEventListener('click', async () => {
                console.log('Button clicked!');
                const code = codeInput.value.trim();
                console.log('Code:', code);
                
                if (!code || code.length !== 6) {
                    try { window.showAlert('error', 'Please enter a valid 6-digit code'); } catch (e) { alert('Please enter a valid 6-digit code'); }
                    return;
                }

                verifyBtn.disabled = true;
                verifyBtn.textContent = 'Verifying...';

                try {
                    console.log('Sending request...');
                    const verifyResponse = await fetch('/api/auth/2fa/google/verify', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        credentials: 'include',
                        body: JSON.stringify({ code })
                    });

                    const responseData = await verifyResponse.json();
                    console.log('Response:', verifyResponse.status, responseData);

                    if (!verifyResponse.ok) {
                        throw new Error(responseData.error || 'Invalid code');
                    }

                    // Update UI
                    const googleAuthStatus = document.getElementById('googleAuthStatus');
                    const enableBtn = document.getElementById('enableGoogleAuthBtn');
                    const disableBtn = document.getElementById('disableGoogleAuthBtn');
                    
                    if (googleAuthStatus) {
                        googleAuthStatus.innerHTML = '<i class="bi bi-check-circle-fill" style="color:#4caf50;"></i> <span>Enabled</span>';
                    }
                    if (enableBtn) enableBtn.style.display = 'none';
                    if (disableBtn) disableBtn.style.display = 'inline-block';

                    // Close modal
                    overlay.remove();

                    try { window.showAlert('success', 'Google Authenticator enabled successfully!'); } catch (e) { await window.showModal('Google Authenticator enabled successfully!', 'Success', { small: true }); }
                } catch (e) {
                    console.error('Error:', e);
                    verifyBtn.disabled = false;
                    verifyBtn.textContent = 'Verify & Enable';
                    try { window.showAlert('error', e.message || 'Verification failed'); } catch (x) { alert(e.message || 'Verification failed'); }
                }
            });
            
            // Focus input
            codeInput.focus();
        }
    } catch (e) {
        console.error('Enable Google Auth error:', e);
        try { window.showAlert('error', e.message || 'Failed to enable Google Authenticator'); } catch (x) { await window.showModal(e.message || 'Failed to enable Google Authenticator', 'Error', { small: true }); }
    }
}

async function disableGoogleAuth() {
    const confirmed = await window.showConfirm(
        'Are you sure you want to disable Google Authenticator? This will reduce your account security.',
        'Disable 2FA'
    );
    
    if (!confirmed) return;

    try {
        const response = await fetch('/api/auth/2fa/google/disable', {
            method: 'POST',
            credentials: 'include'
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Failed to disable Google Authenticator');
        }

        const googleAuthStatus = document.getElementById('googleAuthStatus');
        const enableBtn = document.getElementById('enableGoogleAuthBtn');
        const disableBtn = document.getElementById('disableGoogleAuthBtn');
        
        if (googleAuthStatus) {
            googleAuthStatus.innerHTML = '<i class="bi bi-circle"></i> <span>Not enabled</span>';
        }
        if (enableBtn) enableBtn.style.display = 'inline-block';
        if (disableBtn) disableBtn.style.display = 'none';
        try { window.showAlert('success', 'Google Authenticator disabled'); } catch (e) { await window.showModal('Google Authenticator disabled', 'Success', { small: true }); }
    } catch (e) {
        console.error('Disable Google Auth error:', e);
        try { window.showAlert('error', e.message || 'Failed to disable Google Authenticator'); } catch (x) { await window.showModal(e.message || 'Failed to disable Google Authenticator', 'Error', { small: true }); }
    }
}

async function enableEmailAuth() {
    try {
        const confirmed = await window.showConfirm(
            'Enable email-based 2FA? You will receive a verification code via email each time you log in.',
            'Enable Email 2FA'
        );
        
        if (!confirmed) return;

        const response = await fetch('/api/auth/2fa/email/enable', {
            method: 'POST',
            credentials: 'include'
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Failed to enable email 2FA');
        }

        const emailAuthStatus = document.getElementById('emailAuthStatus');
        const enableBtn = document.getElementById('enableEmailAuthBtn');
        const disableBtn = document.getElementById('disableEmailAuthBtn');
        
        if (emailAuthStatus) {
            emailAuthStatus.innerHTML = '<i class="bi bi-check-circle-fill" style="color:var(--success);"></i> <span>Enabled</span>';
        }
        if (enableBtn) enableBtn.style.display = 'none';
        if (disableBtn) disableBtn.style.display = 'inline-block';
        
        await window.showModal('Email 2FA enabled successfully!', 'Success', { small: true });
    } catch (e) {
        console.error('Enable Email Auth error:', e);
        await window.showModal(e.message || 'Failed to enable email 2FA', 'Error', { small: true });
    }
}

async function disableEmailAuth() {
    const confirmed = await window.showConfirm(
        'Are you sure you want to disable email-based 2FA? This will reduce your account security.',
        'Disable Email 2FA'
    );
    
    if (!confirmed) return;

    try {
        const response = await fetch('/api/auth/2fa/email/disable', {
            method: 'POST',
            credentials: 'include'
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Failed to disable email 2FA');
        }

        const emailAuthStatus = document.getElementById('emailAuthStatus');
        const enableBtn = document.getElementById('enableEmailAuthBtn');
        const disableBtn = document.getElementById('disableEmailAuthBtn');
        
        if (emailAuthStatus) {
            emailAuthStatus.innerHTML = '<i class="bi bi-circle"></i> <span>Not enabled</span>';
        }
        if (enableBtn) enableBtn.style.display = 'inline-block';
        if (disableBtn) disableBtn.style.display = 'none';
        
        await window.showModal('Email 2FA disabled', 'Success', { small: true });
    } catch (e) {
        console.error('Disable Email Auth error:', e);
        await window.showModal(e.message || 'Failed to disable email 2FA', 'Error', { small: true });
    }
}

function setupPreferenceHandlers(modal) {
    // Notification toggle handlers are set up automatically via the toggles
    // No additional handlers needed for simple checkboxes
}

async function saveNotificationSettings() {
    const notifGeneralChat = document.querySelector('#notifGeneralChat')?.checked || false;
    const notifPrivateMessages = document.querySelector('#notifPrivateMessages')?.checked || false;

    try {
        const response = await fetch('/api/auth/settings/notifications', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({
                notif_general_chat: notifGeneralChat,
                notif_private_messages: notifPrivateMessages
            })
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Failed to save notification settings');
        }

        // Also save to localStorage for quick access
        localStorage.setItem('settings_notifGeneralChat', notifGeneralChat);
        localStorage.setItem('settings_notifPrivateMessages', notifPrivateMessages);
    } catch (error) {
        console.error('Save notification settings error:', error);
        throw error;
    }
}

async function loadSettingsPreferences() {
    try {
        // Load settings from backend
        const response = await fetch('/api/auth/settings', {
            credentials: 'include'
        });

        if (!response.ok) {
            console.warn('Failed to load settings from backend, using defaults');
            return;
        }

        const { settings } = await response.json();

        // Load notification preferences
        const notifGeneralChatCheckbox = document.querySelector('#notifGeneralChat');
        const notifPrivateMessagesCheckbox = document.querySelector('#notifPrivateMessages');

        if (notifGeneralChatCheckbox) notifGeneralChatCheckbox.checked = settings.notif_general_chat ?? true;
        if (notifPrivateMessagesCheckbox) notifPrivateMessagesCheckbox.checked = settings.notif_private_messages ?? true;

        // Update localStorage for quick access
        localStorage.setItem('settings_notifGeneralChat', settings.notif_general_chat ?? 'true');
        localStorage.setItem('settings_notifPrivateMessages', settings.notif_private_messages ?? 'true');

        // Load 2FA status
        const googleAuthEnabled = settings.two_factor_enabled ?? false;
        const emailAuthEnabled = settings.email_2fa_enabled ?? false;

        const googleAuthStatus = document.getElementById('googleAuthStatus');
        const enableGoogleAuthBtn = document.getElementById('enableGoogleAuthBtn');
        const disableGoogleAuthBtn = document.getElementById('disableGoogleAuthBtn');
        
        if (googleAuthStatus && enableGoogleAuthBtn && disableGoogleAuthBtn) {
            if (googleAuthEnabled) {
                googleAuthStatus.innerHTML = '<i class="bi bi-check-circle-fill" style="color:var(--success);"></i> <span>Enabled</span>';
                enableGoogleAuthBtn.style.display = 'none';
                disableGoogleAuthBtn.style.display = 'inline-block';
            } else {
                googleAuthStatus.innerHTML = '<i class="bi bi-circle"></i> <span>Not enabled</span>';
                enableGoogleAuthBtn.style.display = 'inline-block';
                disableGoogleAuthBtn.style.display = 'none';
            }
        }

        const emailAuthStatus = document.getElementById('emailAuthStatus');
        const enableEmailAuthBtn = document.getElementById('enableEmailAuthBtn');
        const disableEmailAuthBtn = document.getElementById('disableEmailAuthBtn');
        
        if (emailAuthStatus && enableEmailAuthBtn && disableEmailAuthBtn) {
            if (emailAuthEnabled) {
                emailAuthStatus.innerHTML = '<i class="bi bi-check-circle-fill" style="color:var(--success);"></i> <span>Enabled</span>';
                enableEmailAuthBtn.style.display = 'none';
                disableEmailAuthBtn.style.display = 'inline-block';
            } else {
                emailAuthStatus.innerHTML = '<i class="bi bi-circle"></i> <span>Not enabled</span>';
                enableEmailAuthBtn.style.display = 'inline-block';
                disableEmailAuthBtn.style.display = 'none';
            }
        }
    } catch (error) {
        console.error('Load settings preferences error:', error);
    }
}

// Standalone wrapper functions for settings.html page
window.saveProfileSettings = saveProfileSettings;
window.saveNotificationSettings = async function() {
    try {
        await saveNotificationSettings();
        await window.showModal('Notification settings saved successfully!', 'Success', { small: true });
    } catch (error) {
        await window.showModal('Failed to save notification settings. Please try again.', 'Error', { small: true });
    }
};
window.enableGoogleAuth = enableGoogleAuth;
window.disableGoogleAuth = disableGoogleAuth;
window.enableEmailAuth = enableEmailAuth;
window.disableEmailAuth = disableEmailAuth;
window.loadSettingsPreferences = loadSettingsPreferences;
