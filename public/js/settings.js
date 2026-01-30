// Settings modal helpers
function openSettingsModal() {
    const modal = document.getElementById('settingsModal');
    if (!modal) return;
    modal.classList.add('show');
    // Populate fields when opening
    populateSettingsForm();
}

function closeSettingsModal() {
    const modal = document.getElementById('settingsModal');
    if (!modal) return;
    modal.classList.remove('show');
}

async function populateSettingsForm() {
    const modal = document.getElementById('settingsModal');
    if (!modal) return;
    const displayNameEl = modal.querySelector('#displayName');
    const usernameEl = modal.querySelector('#settingsUsername');
    const avatarInput = modal.querySelector('#avatar');
    const avatarPreview = modal.querySelector('#avatarPreview');
    const saveBtn = modal.querySelector('#saveProfileBtn');

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
            if (displayNameEl) displayNameEl.value = user.display_name || '';
            if (usernameEl) usernameEl.value = user.username || '';
        if (avatarPreview) {
            avatarPreview.src = user.profile_picture_url || '/images/default-avatar.svg';
            avatarPreview.style.display = 'block';
        }
    } catch (e) {
        console.error('Failed to load profile', e);
    }

    // Wire input change
    if (avatarInput) {
        // use .onchange and .onclick to avoid adding multiple listeners on repeated opens
        avatarInput.onchange = (e) => {
            const f = e.target.files[0];
            if (!f) return;
            // Use FileReader to produce a data: URL (blob: may be blocked by CSP)
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
        // Clicking the preview (or placeholder) should open file selector
        if (avatarPreview) avatarPreview.onclick = () => avatarInput.click();
        const placeholderEl = modal.querySelector('#avatarPlaceholder');
        if (placeholderEl) {
            placeholderEl.style.cursor = 'pointer';
            placeholderEl.onclick = () => avatarInput.click();
        }
    }

    if (saveBtn) {
        // remove existing handler to avoid duplicates
        saveBtn.onclick = async () => {
            saveBtn.disabled = true;
            try {
                // Update basic fields first
                const body = { username: document.getElementById('settingsUsername').value.trim(), display_name: document.getElementById('displayName').value.trim() };
                const resp = await fetch('/api/auth/me', {
                    method: 'PUT',
                    credentials: 'include',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body)
                });
                if (!resp.ok) throw new Error('Failed to update profile');

                // If avatar selected, upload it
                const avatarEl = document.getElementById('avatar');
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

                // Refresh UI: update username element if present
                try {
                    const me = await fetch('/api/auth/me', { credentials: 'include' });
                    if (me.ok) {
                        const { user } = await me.json();
                        const headerName = document.getElementById('username');
                        if (headerName) headerName.textContent = user.username;
                        // Update nav/profile avatar if present
                        const navActions = document.querySelector('.navbar .d-flex.gap-md');
                        if (navActions) {
                                const avatar = `<img src="${user.profile_picture_url || '/images/default-avatar.svg'}" onerror="this.onerror=null;this.src='/images/default-avatar.svg'" alt="avatar" style="width:28px;height:28px;border-radius:999px;object-fit:cover;margin-right:8px;">`;
                            navActions.querySelectorAll('a')[0].innerHTML = avatar + 'Profile';
                        }
                        // Dispatch a custom event so other parts of the app can react (e.g., reviewer cards)
                        try {
                            const ev = new CustomEvent('userProfileUpdated', { detail: { user } });
                            window.dispatchEvent(ev);
                        } catch (e) {}
                    }
                } catch (e) {
                    // ignore UI refresh errors
                }

                closeSettingsModal();
            } catch (e) {
                console.error(e);
                alert('Failed to save profile');
            } finally {
                saveBtn.disabled = false;
            }
        };
    }
}
