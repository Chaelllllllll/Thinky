/**
 * Chat JavaScript
 * Handles real-time chat functionality
 */

let currentChatType = 'general';
let currentUser = null;
let messages = [];
let onlineUsers = [];
let messagesSubscription = null;
let onlineUsersSubscription = null;
let currentRecipientId = null;
let currentRecipientName = null;

// Note: Supabase realtime requires configuration on the backend
// For this demo, we'll use polling instead of realtime subscriptions

document.addEventListener('DOMContentLoaded', () => {
    loadCurrentUser();
    loadMessages();
    loadOnlineUsers();

    // If a query param `with` is present, start a private chat with that user id
    try {
        const params = new URLSearchParams(window.location.search);
        const withId = params.get('with') || params.get('withUser') || params.get('user');
        if (withId) {
            // Try to load the target user's public info to get a display name
            fetch(`/api/users/${encodeURIComponent(withId)}`).then(r => {
                if (!r.ok) return null;
                return r.json().then(d => d.user).catch(() => null);
            }).then(user => {
                const name = (user && (user.display_name || user.username)) ? (user.display_name || user.username) : 'User';
                // set recipient and start private chat
                startPrivateChat(withId, name);
            }).catch(() => {
                startPrivateChat(withId, 'User');
            });
        }
    } catch (e) {
        // ignore
    }

    // Poll for new messages every 3 seconds
    setInterval(() => {
        loadMessages(true);
    }, 3000);

    // Poll for online users every 10 seconds
    setInterval(() => {
        loadOnlineUsers();
    }, 10000);

    // Update online status every 30 seconds
    setInterval(updateOnlineStatus, 30000);
    updateOnlineStatus();

    // Enter key to send message
    document.getElementById('messageInput').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            sendMessage();
        }
    });
    // Ensure input/send state reflects current chat selection
    updateChatInputState();
});

function updateChatInputState() {
    const input = document.getElementById('messageInput');
    const sendBtn = document.getElementById('sendBtn');
    const closeBtn = document.getElementById('closePrivateBtn');
    if (!input || !sendBtn) return;

    // Allow sending for non-private chats (general/online).
    if (currentChatType !== 'private') {
        input.disabled = false;
        sendBtn.disabled = false;
        input.placeholder = 'Type your message...';
        if (closeBtn) closeBtn.style.display = 'none';
        return;
    }

    // For private chats, require a selected recipient.
    if (currentChatType === 'private' && !currentRecipientId) {
        input.disabled = true;
        sendBtn.disabled = true;
        input.placeholder = 'Select a user to start a private chat.';
        if (closeBtn) closeBtn.style.display = 'none';
        return;
    }

    // Private chat with recipient selected: allow sending and show close button.
    input.disabled = false;
    sendBtn.disabled = false;
    input.placeholder = 'Type your message...';
    if (closeBtn) closeBtn.style.display = 'inline-block';
}

async function loadCurrentUser() {
    try {
        const response = await fetch('/api/auth/me', { credentials: 'include' });
        if (!response.ok) {
            window.location.href = '/login';
            return;
        }

        const data = await response.json();
        currentUser = data.user;
    } catch (error) {
        console.error('Error loading user:', error);
        window.location.href = '/login';
    }
}

async function loadMessages(silent = false) {
    try {
        let url = `/api/messages/${currentChatType}?limit=100`;
        if (currentChatType === 'private') {
            if (!currentRecipientId) {
                if (!silent) {
                    document.getElementById('chatMessages').innerHTML = `<div style="text-align:center;padding:40px;color:var(--dark-gray);">Select a user to start a private chat.</div>`;
                }
                return;
            }
            url += `&with=${currentRecipientId}`;
        }

        const response = await fetch(url, { credentials: 'include' });

        if (response.status === 401) {
            // Not authenticated: redirect to login so the UI doesn't hang
            console.warn('Not authenticated when loading messages');
            window.location.href = '/login';
            return;
        }

        if (!response.ok) throw new Error('Failed to load messages');

        const data = await response.json();
        const fetched = (data && Array.isArray(data.messages)) ? data.messages : [];

        // Only update if there are new messages (or show empty state)
        if (JSON.stringify(fetched) !== JSON.stringify(messages)) {
            messages = fetched;
            displayMessages(silent);
        } else if (messages.length === 0) {
            // Ensure empty state is shown when there are zero messages
            displayMessages(silent);
        }
    } catch (error) {
        console.error('Error loading messages:', error);
        if (!silent) {
            document.getElementById('chatMessages').innerHTML = `
                <div style="text-align: center; padding: 40px 20px; color: var(--dark-gray);">
                    <i class="bi bi-exclamation-circle" style="font-size: 3rem; color: var(--danger);"></i>
                    <p style="margin-top: 16px;">Failed to load messages</p>
                </div>
            `;
        }
    }
}

function displayMessages(preserveScroll = false) {
    const container = document.getElementById('chatMessages');
    const wasScrolledToBottom = container.scrollHeight - container.scrollTop <= container.clientHeight + 50;

    if (messages.length === 0) {
        container.innerHTML = `
            <div style="text-align: center; padding: 40px 20px; color: var(--dark-gray);">
                <i class="bi bi-chat-text" style="font-size: 3rem; color: var(--primary-pink);"></i>
                <p style="margin-top: 16px;">No messages yet. Start the conversation!</p>
            </div>
        `;
        return;
    }

    container.innerHTML = messages.map(msg => {
        const isSelf = currentUser && String(msg.user_id) === String(currentUser.id);
        const avatarUrl = (msg.users && msg.users.profile_picture_url) ? msg.users.profile_picture_url : '/images/default-avatar.svg';
        const avatar = `<img src="${avatarUrl}" onerror="this.onerror=null;this.src='/images/default-avatar.svg'" alt="avatar" class="msg-avatar"/>`;
        const who = escapeHtml(msg.username || 'User');
        const time = formatTime(msg.created_at);

        return `
        <div class="chat-message ${isSelf ? 'msg-self' : ''}">
            ${avatar}
            <div class="msg-body">
                <div class="msg-bubble ${isSelf ? 'right' : 'left'}">
                    <div class="msg-meta"><span class="msg-author">${who}</span></div>
                    <div class="msg-text">${escapeHtml(msg.message)}</div>
                </div>
                <div class="msg-time-below">${time}</div>
            </div>
        </div>
        `;
    }).join('');

    // Auto-scroll to bottom if user was already at bottom or if it's a new load
    if (!preserveScroll || wasScrolledToBottom) {
        container.scrollTop = container.scrollHeight;
    }
}

async function sendMessage() {
    const input = document.getElementById('messageInput');
    const message = input.value.trim();

    if (!message) return;

    // Prevent sending private messages without a recipient
    if (currentChatType === 'private' && !currentRecipientId) {
        alert('Please select a user to start a private chat.');
        return;
    }

    // Prevent sending messages to yourself
    if (currentChatType === 'private' && currentRecipientId && currentUser && String(currentRecipientId) === String(currentUser.id)) {
        alert('You cannot send messages to yourself.');
        return;
    }

    try {
        const body = { message, chat_type: currentChatType };
        if (currentChatType === 'private' && currentRecipientId) {
            body.recipient_id = currentRecipientId;
        }

        const response = await fetch('/api/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            credentials: 'include',
            body: JSON.stringify(body)
        });

        if (!response.ok) throw new Error('Failed to send message');

        input.value = '';
        
        // Immediately reload messages
        await loadMessages();
    } catch (error) {
        console.error('Error sending message:', error);
        alert('Failed to send message. Please try again.');
    }
}

async function loadOnlineUsers() {
    try {
        const response = await fetch('/api/online-users', { credentials: 'include' });
        if (!response.ok) throw new Error('Failed to load online users');

        const data = await response.json();
        onlineUsers = data.onlineUsers;
        displayOnlineUsers();
    } catch (error) {
        console.error('Error loading online users:', error);
    }
}

function displayOnlineUsers() {
    const container = document.getElementById('onlineUsersList');
    const count = document.getElementById('onlineCount');

    count.textContent = onlineUsers.length;

    if (onlineUsers.length === 0) {
        container.innerHTML = `
            <div style="text-align: center; width: 100%; padding: 20px; color: var(--dark-gray);">
                <i class="bi bi-person-slash"></i>
                <p style="margin-top: 8px; font-size: 0.875rem;">No users online</p>
            </div>
        `;
        return;
    }

    container.innerHTML = onlineUsers.map(user => `
        <div class="online-user" data-user-id="${user.user_id}" data-username="${escapeHtml(user.username)}">
            <span class="online-indicator"></span>
            <span>${escapeHtml(user.username)}</span>
        </div>
    `).join('');

    // Attach click handlers to start private chat
    container.querySelectorAll('.online-user').forEach(el => {
        el.addEventListener('click', () => {
            const id = el.getAttribute('data-user-id');
            const name = el.getAttribute('data-username');
            startPrivateChat(id, name);
        });
    });
    // Update input state in case current mode requires recipient
    updateChatInputState();
}

// Start a private chat with another user
async function startPrivateChat(userId, username) {
    // Ensure we know the current user before allowing private chat
    if (!currentUser) {
        try {
            const resp = await fetch('/api/auth/me', { credentials: 'include' });
            if (resp.ok) {
                const d = await resp.json();
                currentUser = d.user;
            }
        } catch (e) { /* ignore */ }
    }

    // Prevent starting a private chat with yourself
    if (currentUser && String(currentUser.id) === String(userId)) {
        alert('You cannot start a private chat with yourself.');
        return;
    }

    currentChatType = 'private';
    currentRecipientId = userId;
    currentRecipientName = username;

    // Update header
    const headerTitle = document.getElementById('chatHeaderTitle');
    if (headerTitle) headerTitle.textContent = `Private chat with ${username}`;

    const closeBtn = document.getElementById('closePrivateBtn');
    if (closeBtn) {
        closeBtn.style.display = 'inline-block';
        closeBtn.onclick = closePrivateChat;
    }

    // Load messages for private chat
    messages = [];
    document.getElementById('chatMessages').innerHTML = `
        <div style="text-align: center; padding: 40px 20px; color: var(--dark-gray);">
            <div class="spinner"></div>
            <p style="margin-top: 16px;">Loading messages...</p>
        </div>
    `;
    loadMessages();
    updateChatInputState();
}

function closePrivateChat() {
    currentChatType = 'general';
    currentRecipientId = null;
    currentRecipientName = null;

    const headerTitle = document.getElementById('chatHeaderTitle');
    if (headerTitle) headerTitle.textContent = 'General Chat';

    const closeBtn = document.getElementById('closePrivateBtn');
    if (closeBtn) closeBtn.style.display = 'none';

    messages = [];
    document.getElementById('chatMessages').innerHTML = `
        <div style="text-align: center; padding: 40px 20px; color: var(--dark-gray);">
            <div class="spinner"></div>
            <p style="margin-top: 16px;">Loading messages...</p>
        </div>
    `;
    loadMessages();
    updateChatInputState();
}

function switchChat(type) {
    // Map UI tab types to internal chat types. 'personal' maps to private mode.
    if (type === 'personal') {
        currentChatType = 'private';
        // Clear any previously selected recipient so users must pick someone
        currentRecipientId = null;
        currentRecipientName = null;
    } else {
        currentChatType = type;
        // Leaving recipient null when switching to general
        if (type === 'general') {
            currentRecipientId = null;
            currentRecipientName = null;
        }
    }

    // Update tabs
    document.querySelectorAll('.chat-tab').forEach(tab => {
        tab.classList.remove('active');
    });
    if (event && event.target) {
        const tabEl = event.target.closest('.chat-tab');
        if (tabEl) tabEl.classList.add('active');
    }

    // Update header
    const headerTitle = document.getElementById('chatHeaderTitle');
    if (headerTitle) headerTitle.textContent = currentChatType === 'general' ? 'General Chat' : 'Personal Chat';

    // Load messages for the selected mode
    messages = [];
    const chatMessagesEl = document.getElementById('chatMessages');
    if (chatMessagesEl) chatMessagesEl.innerHTML = `
        <div style="text-align: center; padding: 40px 20px; color: var(--dark-gray);">
            <div class="spinner"></div>
            <p style="margin-top: 16px;">Loading messages...</p>
        </div>
    `;
    loadMessages();
    updateChatInputState();
}

async function updateOnlineStatus() {
    try {
        await fetch('/api/online-status', {
            method: 'POST',
            credentials: 'include'
        });
    } catch (error) {
        console.error('Error updating online status:', error);
    }
}

function formatTime(timestamp) {
    const date = new Date(timestamp);
    const now = new Date();
    const diff = now - date;
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return 'Just now';
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days < 7) return `${days}d ago`;
    
    return date.toLocaleDateString();
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function toggleSidebar() {
    document.getElementById('sidebar').classList.toggle('show');
}

async function logout() {
    if (!confirm('Are you sure you want to logout?')) {
        return;
    }

    try {
        await fetch('/api/auth/logout', {
            method: 'POST',
            credentials: 'include'
        });
        window.location.href = '/login';
    } catch (error) {
        console.error('Logout error:', error);
        window.location.href = '/login';
    }
}
