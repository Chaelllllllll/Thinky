/**
 * Message Button Modal
 * - Private tab: social list (followers/following/mutual) and in-modal conversation view
 * - General tab: chat-like feed with composer and anonymous toggle
 */

const PRIVATE_POLL_INTERVAL_MS = 5000;
const PRIVATE_CONTACTS_PAGE_SIZE = 20;
const PRIVATE_MESSAGES_PAGE_SIZE = 40;
const GENERAL_MESSAGES_PAGE_SIZE = 40;
const MESSAGE_REACTION_TYPES = ['like', 'love', 'haha', 'sad', 'wow', 'angry'];
const MESSAGE_REACTION_EMOJIS = {
    like: '👍',
    love: '❤️',
    haha: '😂',
    sad: '😢',
    wow: '😮',
    angry: '😡'
};

let messageButtonState = {
    unreadCount: 0,
    currentTab: 'private',
    privateContacts: [],
    privateContactsRendered: 0,
    generalMessages: [],
    privateConversationMessages: [],
    privateHasMore: true,
    privateLoadingOlder: false,
    generalHasMore: true,
    generalLoadingOlder: false,
    currentUser: null,
    activePrivateUser: null,
    privateReplyTo: null,
    privateReplyMeta: null,
    isLoadingPrivate: false,
    isLoadingGeneral: false,
    isLoadingConversation: false,
    isSendingPrivate: false,
    isSendingGeneral: false,
    generalAnonMode: false,
    generalReplyTo: null,
    generalReplyMeta: null,
    unreadPerUser: {},
    handlersBound: false,
    touchHoldTimer: null,
    touchHoldTriggered: false,
    unreadIntervalId: null,
    privatePollIntervalId: null
};

async function initMessageButton() {
    try {
        injectMessageModalPrivateStyles();

        const resp = await fetch('/api/auth/me', { credentials: 'include' });
        if (!resp.ok) return;

        const data = await resp.json();
        messageButtonState.currentUser = data.user;
        const modalEl = document.getElementById('messageModal');
        if (modalEl && !document.getElementById('msgFloatingMenu')) {
            const fm = document.createElement('div');
            fm.id = 'msgFloatingMenu';
            modalEl.appendChild(fm);
        }

        bindMessageModalEvents();

        await updateMessageUnreadBadge();

        if (messageButtonState.unreadIntervalId) {
            clearInterval(messageButtonState.unreadIntervalId);
        }
        messageButtonState.unreadIntervalId = setInterval(updateMessageUnreadBadge, PRIVATE_POLL_INTERVAL_MS);
    } catch (err) {
        console.error('Failed to init message button:', err);
    }
}

function injectMessageModalPrivateStyles() {
    if (document.getElementById('msgModalPrivateStyles')) return;

    const style = document.createElement('style');
    style.id = 'msgModalPrivateStyles';
    style.textContent = `
        #msgContent-private,
        #msgContent-general {
            min-height: 0;
            overflow: hidden;
        }

        #msgPrivateList,
        #msgGeneralList {
            display: flex;
            flex-direction: column;
            flex: 1;
            min-height: 0;
        }

        #msgPrivateList {
            overflow-y: auto;
        }

        .msg-private-list-title {
            padding: 12px 14px;
            font-size: 0.8rem;
            color: var(--dark-gray);
            border-bottom: 1px solid var(--light-gray);
            letter-spacing: 0.04em;
            text-transform: uppercase;
            font-weight: 700;
            background: var(--off-white);
        }

        .msg-private-meta {
            display: flex;
            align-items: center;
            gap: 6px;
            margin-top: 2px;
            font-size: 0.74rem;
            color: var(--dark-gray);
        }

        .msg-private-side {
            margin-left: auto;
            min-width: 74px;
            display: flex;
            flex-direction: column;
            align-items: flex-end;
            justify-content: center;
            gap: 4px;
        }

        .msg-private-relation {
            background: rgba(255, 158, 180, 0.12);
            color: var(--primary-pink-dark, var(--primary-pink));
            border: 1px solid rgba(255, 158, 180, 0.28);
            padding: 1px 6px;
            border-radius: 999px;
            font-weight: 600;
            font-size: 0.69rem;
            line-height: 1.15;
        }

        .msg-private-load-more {
            text-align: center;
            font-size: 0.76rem;
            color: var(--dark-gray);
            padding: 10px 12px;
            border-top: 1px solid var(--light-gray);
            background: var(--off-white);
        }

        .msg-private-unread {
            min-width: 18px;
            height: 18px;
            padding: 0 6px;
            border-radius: 999px;
            background: var(--danger);
            color: #fff;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            font-size: 0.68rem;
            font-weight: 700;
            line-height: 1;
        }

        .msg-private-chat-wrap {
            display: flex;
            flex-direction: column;
            flex: 1;
            height: 100%;
            min-height: 0;
            background: var(--white);
            overflow: hidden;
        }

        .msg-private-chat-head {
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 10px 12px;
            border-bottom: 1px solid var(--light-gray);
            background: var(--off-white);
            flex-shrink: 0;
        }

        .msg-private-back {
            width: 34px;
            height: 34px;
            border-radius: 999px;
            border: 1px solid var(--medium-gray);
            background: var(--white);
            color: var(--text-dark);
            display: inline-flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
        }

        .msg-private-head-avatar {
            width: 34px;
            height: 34px;
            border-radius: 50%;
            object-fit: cover;
            border: 1px solid var(--medium-gray);
            flex-shrink: 0;
        }

        .msg-private-head-name {
            font-size: 0.95rem;
            font-weight: 700;
            color: var(--text-dark);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .msg-private-profile-link {
            cursor: pointer;
        }

        .msg-private-profile-link:hover {
            opacity: 0.9;
        }

        .msg-private-chat-body {
            flex: 1;
            min-height: 0;
            overflow-y: auto;
            padding: 10px;
            display: flex;
            flex-direction: column;
            gap: 8px;
            background: var(--white);
        }

        .msg-private-empty {
            margin: auto;
            text-align: center;
            color: var(--dark-gray);
            padding: 20px;
        }

        .msg-private-row {
            display: flex;
            align-items: flex-end;
            gap: 8px;
            width: 100%;
        }

        .msg-private-msg-main {
            display: flex;
            align-items: flex-end;
            gap: 6px;
            min-width: 0;
            max-width: 86%;
        }

        .msg-private-row.self .msg-private-msg-main,
        .msg-general-row.self .msg-private-msg-main {
            margin-left: auto;
        }

        .msg-private-row.other .msg-private-msg-main,
        .msg-general-row.other .msg-private-msg-main {
            margin-right: auto;
        }

        .msg-private-row.self {
            justify-content: flex-end;
        }

        .msg-private-row.other {
            justify-content: flex-start;
        }

        .msg-private-msg-avatar {
            width: 28px;
            height: 28px;
            border-radius: 50%;
            object-fit: cover;
            border: 1px solid var(--medium-gray);
            flex-shrink: 0;
        }

        .msg-private-bubble {
            max-width: 100%;
            border-radius: 16px;
            padding: 10px 12px;
            font-size: 0.9rem;
            line-height: 1.35;
            word-break: break-word;
            box-shadow: 0 1px 3px rgba(0, 0, 0, 0.07);
        }

        .msg-private-bubble.self {
            background: var(--gradient-primary);
            color: #fff;
            border-bottom-right-radius: 6px;
        }

        .msg-private-bubble.other {
            background: var(--off-white);
            color: var(--text-dark);
            border: 1px solid var(--light-gray);
            border-bottom-left-radius: 6px;
        }

        .msg-modal-actions-inline {
            position: relative;
            align-self: flex-start;
            flex-shrink: 0;
        }

        .msg-modal-more-btn {
            width: 24px;
            height: 24px;
            border: none;
            background: transparent;
            color: var(--dark-gray);
            border-radius: 6px;
            cursor: pointer;
            display: none;
            align-items: center;
            justify-content: center;
            padding: 0;
        }

        .msg-private-row.selected .msg-modal-more-btn,
        .msg-general-row.selected .msg-modal-more-btn {
            display: inline-flex;
        }

        .msg-modal-more-btn:hover {
            background: var(--light-gray);
        }

        .msg-modal-actions-menu {
            display: none;
            position: absolute;
            top: 26px;
            right: 0;
            min-width: 170px;
            border: 1px solid var(--medium-gray);
            background: var(--white);
            border-radius: 10px;
            box-shadow: var(--shadow-md);
            z-index: 30;
            overflow: visible;
            padding: 6px;
        }

        #msgFloatingMenu {
            display: none;
            position: absolute;
            min-width: 175px;
            border: 1px solid var(--medium-gray);
            background: var(--white);
            border-radius: 10px;
            box-shadow: var(--shadow-md);
            z-index: 50;
            padding: 6px;
        }

        #msgFloatingMenu.show {
            display: block;
        }

        .msg-modal-action-btn {
            width: 100%;
            border: none;
            background: transparent;
            color: var(--text-dark);
            border-radius: 8px;
            padding: 8px 10px;
            font-size: 0.8rem;
            text-align: left;
            cursor: pointer;
            line-height: 1.2;
        }

        .msg-modal-action-btn i {
            margin-right: 6px;
        }

        .msg-modal-action-btn:hover {
            background: var(--off-white);
        }

        .msg-modal-action-btn.danger {
            color: #d84e5f;
        }

        .msg-private-reaction-wrap { position: relative; }

        .msg-private-reaction-picker {
            display: none;
            flex-direction: row;
            flex-wrap: wrap;
            padding: 4px 2px;
            gap: 4px;
        }

        .msg-private-reaction-picker.show { display: flex; }

        .msg-private-reaction-choice {
            border: none;
            background: transparent;
            width: 30px;
            height: 30px;
            border-radius: 50%;
            font-size: 1rem;
            cursor: pointer;
        }

        .msg-private-reaction-choice:hover { background: var(--light-gray); }

        .msg-private-reactions-row {
            display: flex;
            align-items: center;
            gap: 6px;
            flex-wrap: wrap;
            margin-top: 4px;
        }

        .msg-private-reaction-chip {
            border: 1px solid var(--medium-gray);
            background: var(--white);
            color: var(--text-dark);
            border-radius: 999px;
            padding: 2px 8px;
            font-size: 0.75rem;
            line-height: 1.2;
            cursor: pointer;
        }

        .msg-private-reaction-chip.mine {
            border-color: var(--primary-pink);
            background: rgba(255, 158, 180, 0.14);
        }

        .msg-general-chat-wrap {
            display: flex;
            flex-direction: column;
            flex: 1;
            min-height: 0;
            height: 100%;
            background: var(--white);
            overflow: hidden;
        }

        .msg-general-body {
            flex: 1;
            min-height: 0;
            overflow-y: auto;
            padding: 10px;
            display: flex;
            flex-direction: column;
            gap: 8px;
            background: var(--white);
        }

        .msg-general-row {
            display: flex;
            align-items: flex-end;
            gap: 8px;
            width: 100%;
        }

        .msg-general-row.self {
            justify-content: flex-end;
        }

        .msg-general-row.other {
            justify-content: flex-start;
        }

        .msg-general-row .msg-private-msg-main,
        .msg-private-row .msg-private-msg-main {
            width: fit-content;
        }

        .msg-general-row.selected .msg-private-bubble {
            box-shadow: 0 0 0 2px rgba(255, 158, 180, 0.42), 0 1px 3px rgba(0, 0, 0, 0.07);
        }

        .msg-general-composer-wrap {
            border-top: 1px solid var(--light-gray);
            background: var(--white);
            padding: 8px 10px 10px;
            padding-bottom: calc(10px + env(safe-area-inset-bottom));
            flex-shrink: 0;
        }

        .msg-general-anon-row {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
            margin-bottom: 8px;
        }

        .msg-general-anon-toggle {
            border: 1px solid var(--medium-gray);
            background: var(--off-white);
            color: var(--text-dark);
            border-radius: 999px;
            padding: 6px 12px;
            font-size: 0.78rem;
            cursor: pointer;
            display: inline-flex;
            align-items: center;
            gap: 6px;
            font-weight: 600;
        }

        .msg-general-anon-toggle.active {
            border-color: var(--primary-pink);
            color: var(--primary-pink);
            background: rgba(255, 158, 180, 0.12);
        }

        .msg-general-anon-banner {
            display: none;
            font-size: 0.78rem;
            color: var(--dark-gray);
            background: var(--off-white);
            border: 1px solid var(--light-gray);
            border-radius: 8px;
            padding: 6px 8px;
            margin-bottom: 8px;
        }

        .msg-general-composer {
            display: flex;
            align-items: center;
            gap: 8px;
        }

        .msg-general-input {
            flex: 1;
            border: 1px solid var(--medium-gray);
            background: var(--off-white);
            color: var(--text-dark);
            border-radius: 999px;
            padding: 10px 14px;
            font-size: 0.9rem;
            outline: none;
        }

        .msg-general-input:focus {
            border-color: var(--primary-pink);
            box-shadow: 0 0 0 3px rgba(255, 158, 180, 0.2);
        }

        .msg-general-send {
            width: 42px;
            height: 42px;
            border: none;
            border-radius: 999px;
            background: var(--gradient-primary);
            color: #fff;
            font-size: 1rem;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            box-shadow: var(--shadow-sm);
        }

        .msg-general-send:disabled {
            opacity: 0.65;
            cursor: default;
        }

        .msg-private-reply-banner {
            display: none;
            align-items: flex-start;
            justify-content: space-between;
            gap: 10px;
            padding: 8px 10px;
            border-bottom: 1px solid var(--light-gray);
            background: var(--off-white);
            color: var(--text-dark);
            flex-shrink: 0;
        }

        .msg-private-reply-text {
            min-width: 0;
            font-size: 0.8rem;
            color: var(--dark-gray);
        }

        .msg-private-reply-cancel {
            border: none;
            background: transparent;
            color: var(--dark-gray);
            cursor: pointer;
            font-size: 1rem;
            line-height: 1;
            padding: 2px 4px;
            border-radius: 6px;
        }

        .msg-private-reply-cancel:hover { background: var(--light-gray); }

        .msg-private-row.selected .msg-private-bubble {
            box-shadow: 0 0 0 2px rgba(255, 158, 180, 0.42), 0 1px 3px rgba(0, 0, 0, 0.07);
        }

        .msg-private-author {
            font-size: 0.74rem;
            color: var(--dark-gray);
            font-weight: 600;
            margin-bottom: 4px;
            line-height: 1;
        }

        .msg-private-composer {
            border-top: 1px solid var(--light-gray);
            padding: 10px;
            padding-bottom: calc(10px + env(safe-area-inset-bottom));
            display: flex;
            align-items: center;
            gap: 8px;
            background: var(--white);
            flex-shrink: 0;
            position: sticky;
            bottom: 0;
            z-index: 2;
        }

        .msg-private-input {
            flex: 1;
            border: 1px solid var(--medium-gray);
            background: var(--off-white);
            color: var(--text-dark);
            border-radius: 999px;
            padding: 10px 14px;
            font-size: 0.9rem;
            outline: none;
        }

        .msg-private-input:focus {
            border-color: var(--primary-pink);
            box-shadow: 0 0 0 3px rgba(255, 158, 180, 0.2);
        }

        .msg-private-send {
            width: 42px;
            height: 42px;
            border: none;
            border-radius: 999px;
            background: var(--gradient-primary);
            color: #fff;
            font-size: 1rem;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            box-shadow: var(--shadow-sm);
        }

        .msg-private-send:disabled {
            opacity: 0.65;
            cursor: default;
        }

        body.dark .msg-private-list-title {
            background: #252525;
            border-bottom-color: #3b3b3b;
            color: #b7b7b7;
        }

        body.dark .msg-private-chat-wrap,
        body.dark .msg-private-chat-body,
        body.dark .msg-private-composer {
            background: #1e1e1e;
        }

        body.dark .msg-private-chat-head {
            background: #252525;
            border-bottom-color: #3b3b3b;
        }

        body.dark .msg-private-back {
            background: #1e1e1e;
            border-color: #3f3f3f;
            color: #e0e0e0;
        }

        body.dark .msg-private-head-avatar {
            border-color: #3f3f3f;
        }

        body.dark .msg-private-msg-avatar {
            border-color: #3f3f3f;
        }

        body.dark .msg-private-head-name {
            color: #e0e0e0;
        }

        body.dark .msg-private-bubble.other {
            background: #2a2a2a;
            color: #e0e0e0;
            border-color: #3b3b3b;
        }

        body.dark .msg-modal-more-btn {
            color: #b7b7b7;
        }

        body.dark .msg-modal-more-btn:hover {
            background: #2c2c2c;
        }

        body.dark #msgFloatingMenu {
            background: #1f1f1f;
            border-color: #444;
        }

        body.dark .msg-modal-action-btn {
            color: #e0e0e0;
        }

        body.dark .msg-modal-action-btn:hover {
            background: #2c2c2c;
        }

        body.dark .msg-private-reaction-chip {
            background: #262626;
            color: #d9d9d9;
            border-color: #444;
        }

        body.dark .msg-private-reaction-chip.mine {
            border-color: #ff9eb4;
            background: rgba(255, 158, 180, 0.2);
        }

        body.dark .msg-private-reaction-picker {
            background: #1f1f1f;
            border-color: #444;
        }

        body.dark .msg-private-reaction-choice:hover { background: #2c2c2c; }

        body.dark .msg-private-load-more {
            background: #252525;
            border-top-color: #3b3b3b;
            color: #b7b7b7;
        }

        body.dark .msg-general-chat-wrap,
        body.dark .msg-general-body,
        body.dark .msg-general-composer-wrap {
            background: #1e1e1e;
        }

        body.dark .msg-general-anon-banner {
            background: #252525;
            border-color: #3b3b3b;
            color: #b7b7b7;
        }

        body.dark .msg-general-anon-toggle {
            background: #262626;
            border-color: #444;
            color: #d9d9d9;
        }

        body.dark .msg-general-anon-toggle.active {
            border-color: #ff9eb4;
            color: #ff9eb4;
            background: rgba(255, 158, 180, 0.2);
        }

        body.dark .msg-general-row.selected .msg-private-bubble {
            box-shadow: 0 0 0 2px rgba(255, 158, 180, 0.45), 0 1px 3px rgba(0, 0, 0, 0.2);
        }

        body.dark .msg-private-reply-banner {
            background: #252525;
            border-bottom-color: #3b3b3b;
            color: #e0e0e0;
        }

        body.dark .msg-private-reply-text,
        body.dark .msg-private-reply-cancel {
            color: #b7b7b7;
        }

        body.dark .msg-private-reply-cancel:hover { background: #2c2c2c; }

        body.dark .msg-private-author {
            color: #b7b7b7;
        }

        body.dark .msg-private-row.selected .msg-private-bubble {
            box-shadow: 0 0 0 2px rgba(255, 158, 180, 0.45), 0 1px 3px rgba(0, 0, 0, 0.2);
        }

        body.dark .msg-private-input {
            background: #2a2a2a;
            border-color: #3f3f3f;
            color: #e0e0e0;
        }

        body.dark .msg-private-input:focus {
            border-color: #ff9eb4;
            box-shadow: 0 0 0 3px rgba(255, 158, 180, 0.16);
        }

        body.dark .msg-general-input {
            background: #2a2a2a;
            border-color: #3f3f3f;
            color: #e0e0e0;
        }

        body.dark .msg-general-input:focus {
            border-color: #ff9eb4;
            box-shadow: 0 0 0 3px rgba(255, 158, 180, 0.16);
        }

        .msg-goto-reply {
            cursor: pointer;
        }

        .msg-goto-reply:hover {
            opacity: 0.7;
        }

        .msg-highlighted .msg-private-bubble {
            animation: msgHighlightPulse 1.5s ease-out forwards;
        }

        @keyframes msgHighlightPulse {
            0% { box-shadow: 0 0 0 3px rgba(255, 158, 180, 0.85), 0 1px 3px rgba(0,0,0,0.1); }
            100% { box-shadow: 0 1px 3px rgba(0,0,0,0.07); }
        }

        @media (max-width: 768px) {
            .msg-private-bubble {
                max-width: 88%;
                font-size: 0.9rem;
            }
        }
    `;

    document.head.appendChild(style);
}

async function updateMessageUnreadBadge() {
    try {
        const lastSeenGeneral = localStorage.getItem('chat_last_seen_general') || new Date().toISOString();
        const lastSeenPrivate = localStorage.getItem('chat_last_seen_private') || new Date().toISOString();

        const resp = await fetch(
            `/api/messages/unread?lastSeenGeneral=${encodeURIComponent(lastSeenGeneral)}&lastSeenPrivate=${encodeURIComponent(lastSeenPrivate)}`,
            { credentials: 'include' }
        );

        if (!resp.ok) return;

        const data = await resp.json();
        const total = (parseInt(data.general || 0, 10) + parseInt(data.private || 0, 10)) || 0;
        messageButtonState.unreadCount = total;

        const badge = document.getElementById('msgBtnBadge');
        if (!badge) return;

        if (total > 0) {
            badge.style.display = 'flex';
            badge.textContent = total > 99 ? '99+' : String(total);
        } else {
            badge.style.display = 'none';
        }
    } catch (err) {
        console.error('Failed to update unread badge:', err);
    }
}

function openMessageModal() {
    const modal = document.getElementById('messageModal');
    if (!modal) {
        console.error('Message modal not found');
        return;
    }

    modal.classList.add('show');
    modal.style.display = '';
    switchMessageTab('private');
}

function closeMessageModal() {
    const modal = document.getElementById('messageModal');
    if (!modal) return;

    stopPrivateConversationPolling();
    messageButtonState.privateReplyTo = null;
    messageButtonState.privateReplyMeta = null;
    messageButtonState.generalReplyTo = null;
    messageButtonState.generalReplyMeta = null;
    closeAllModalReactionPickers();
    closeAllModalActionMenus();
    clearModalMessageSelection();
    modal.classList.remove('show');
    modal.style.display = 'none';
}

function switchMessageTab(tab) {
    messageButtonState.currentTab = tab;

    document.querySelectorAll('.msg-modal-tab').forEach((t) => t.classList.remove('active'));
    document.getElementById(`msgTab-${tab}`)?.classList.add('active');

    document.querySelectorAll('.msg-modal-content').forEach((c) => {
        c.style.display = 'none';
    });

    const contentDiv = document.getElementById(`msgContent-${tab}`);
    if (contentDiv) contentDiv.style.display = 'flex';

    clearModalMessageSelection();
    closeAllModalActionMenus();
    closeAllModalReactionPickers();

    if (tab === 'private') {
        messageButtonState.activePrivateUser = null;
        messageButtonState.privateReplyTo = null;
        messageButtonState.privateReplyMeta = null;
        renderPrivateReplyBanner();
        stopPrivateConversationPolling();
        loadPrivateContacts();
    } else {
        messageButtonState.privateReplyTo = null;
        messageButtonState.privateReplyMeta = null;
        renderPrivateReplyBanner();
        stopPrivateConversationPolling();
        loadGeneralMessages();
    }
}

function bindMessageModalEvents() {
    if (messageButtonState.handlersBound) return;
    messageButtonState.handlersBound = true;

    document.addEventListener('touchstart', (event) => {
        const target = event.target;
        if (!(target instanceof Element)) return;

        const modal = document.getElementById('messageModal');
        if (!modal || !modal.contains(target)) return;

        const selectable = target.closest('[data-selectable-message]');
        if (!selectable) return;
        if (target.closest('.msg-modal-more-btn, .msg-modal-actions-menu, .msg-private-reaction-choice, .msg-private-reaction-chip')) return;

        if (messageButtonState.touchHoldTimer) {
            clearTimeout(messageButtonState.touchHoldTimer);
            messageButtonState.touchHoldTimer = null;
        }
        messageButtonState.touchHoldTriggered = false;

        messageButtonState.touchHoldTimer = setTimeout(() => {
            clearModalMessageSelection();
            selectable.classList.add('selected');
            messageButtonState.touchHoldTriggered = true;
        }, 420);
    }, { passive: true });

    const clearTouchHold = () => {
        if (messageButtonState.touchHoldTimer) {
            clearTimeout(messageButtonState.touchHoldTimer);
            messageButtonState.touchHoldTimer = null;
        }
    };

    document.addEventListener('touchend', clearTouchHold, { passive: true });
    document.addEventListener('touchcancel', clearTouchHold, { passive: true });

    document.addEventListener('click', (event) => {
        const target = event.target;
        if (!(target instanceof Element)) return;

        const modal = document.getElementById('messageModal');
        if (!modal || !modal.contains(target)) {
            closeAllModalReactionPickers();
            closeAllModalActionMenus();
            clearModalMessageSelection();
            return;
        }

        const moreBtn = target.closest('.msg-modal-more-btn');
        if (moreBtn) {
            event.preventDefault();
            event.stopPropagation();

            const fm = document.getElementById('msgFloatingMenu');
            if (!fm) return;

            const currentMsgId = moreBtn.getAttribute('data-msg-id') || '';
            const isOpen = fm.classList.contains('show') && fm.dataset.activeMsgId === currentMsgId;
            closeAllModalActionMenus();
            closeAllModalReactionPickers();

            if (!isOpen) {
                const msgId = currentMsgId;
                const section = moreBtn.getAttribute('data-section') || 'private';
                const isSelf = moreBtn.getAttribute('data-is-self') === '1';
                const includeReply = moreBtn.getAttribute('data-include-reply') === '1';
                const menuAlign = moreBtn.getAttribute('data-menu-align') || 'right';

                fm.dataset.activeMsgId = msgId;
                fm.innerHTML = [
                    includeReply ? `<button class="msg-modal-action-btn" data-modal-action="reply" data-section="${section}" data-message-id="${msgId}"><i class="bi bi-reply"></i> Reply</button>` : '',
                    `<div class="msg-private-reaction-wrap">`,
                    `<button class="msg-modal-action-btn" data-modal-action="react" data-section="${section}" data-message-id="${msgId}"><i class="bi bi-emoji-smile"></i> React</button>`,
                    `<div class="msg-private-reaction-picker" data-message-id="${msgId}" data-section="${section}">`,
                    MESSAGE_REACTION_TYPES.map(t => `<button class="msg-private-reaction-choice" data-reaction="${t}" data-message-id="${msgId}" data-section="${section}" title="${t}">${MESSAGE_REACTION_EMOJIS[t]}</button>`).join(''),
                    `</div></div>`,
                    isSelf ? `<button class="msg-modal-action-btn danger" data-modal-action="delete-all" data-section="${section}" data-message-id="${msgId}">Delete for Everyone</button>` : '',
                    `<button class="msg-modal-action-btn danger" data-modal-action="delete-me" data-section="${section}" data-message-id="${msgId}">Delete for You</button>`
                ].join('');

                const btnRect = moreBtn.getBoundingClientRect();
                const modalRect = document.getElementById('messageModal').getBoundingClientRect();
                const menuWidth = 175;
                const menuHeight = 170;
                const topIfBelow = btnRect.bottom - modalRect.top + 4;
                const topIfAbove = btnRect.top - modalRect.top - menuHeight - 4;
                fm.style.top = (topIfBelow + menuHeight > modalRect.height - 4
                    ? Math.max(4, topIfAbove)
                    : topIfBelow) + 'px';
                fm.style.bottom = 'auto';

                if (menuAlign === 'left') {
                    fm.style.left = Math.max(4, Math.min(btnRect.left - modalRect.left, modalRect.width - menuWidth - 4)) + 'px';
                    fm.style.right = 'auto';
                } else {
                    fm.style.right = Math.max(4, Math.min(modalRect.right - btnRect.right, modalRect.width - menuWidth - 4)) + 'px';
                    fm.style.left = 'auto';
                }

                fm.classList.add('show');
            }
            return;
        }

        const selectable = target.closest('[data-selectable-message]');
        const clickedInteractive = !!target.closest('[data-modal-action], .msg-modal-actions-menu, .msg-private-reaction-choice, .msg-private-reaction-chip');
        if (selectable && !clickedInteractive) {
            event.preventDefault();
            event.stopPropagation();

            if (messageButtonState.touchHoldTriggered) {
                messageButtonState.touchHoldTriggered = false;
                return;
            }

            const alreadySelected = selectable.classList.contains('selected');
            clearModalMessageSelection();
            if (!alreadySelected) selectable.classList.add('selected');
            closeAllModalActionMenus();
            closeAllModalReactionPickers();
            return;
        }

        const actionEl = target.closest('[data-modal-action]');
        if (actionEl) {
            event.preventDefault();
            event.stopPropagation();

            const action = actionEl.getAttribute('data-modal-action') || '';
            const messageId = actionEl.getAttribute('data-message-id') || '';
            const section = actionEl.getAttribute('data-section') || 'private';
            if (!messageId) return;

            if (action === 'reply') {
                const msg = findModalMessageById(messageId, section);
                if (!msg) return;
                if (section === 'general') {
                    messageButtonState.generalReplyTo = msg.id;
                    messageButtonState.generalReplyMeta = {
                        username: msg.username || ((msg.users && msg.users.username) ? msg.users.username : 'User'),
                        message: msg.message || ''
                    };
                    renderGeneralReplyBanner();
                    closeAllModalActionMenus();
                    document.getElementById('msgGeneralInput')?.focus();
                } else {
                    messageButtonState.privateReplyTo = msg.id;
                    messageButtonState.privateReplyMeta = {
                        username: msg.username || ((msg.users && msg.users.username) ? msg.users.username : 'User'),
                        message: msg.message || ''
                    };
                    renderPrivateReplyBanner();
                    closeAllModalActionMenus();
                    document.getElementById('msgPrivateComposerInput')?.focus();
                }
                return;
            }

            if (action === 'react') {
                const wrap = actionEl.closest('.msg-private-reaction-wrap');
                const picker = wrap ? wrap.querySelector('.msg-private-reaction-picker') : null;
                if (!picker) return;
                const isOpen = picker.classList.contains('show');
                closeAllModalReactionPickers();
                if (!isOpen) picker.classList.add('show');
                return;
            }

            if (action === 'delete-all') {
                if (window.confirm('Delete this message for everyone?')) {
                    deleteModalMessage(messageId, 'all', section);
                }
                closeAllModalActionMenus();
                return;
            }

            if (action === 'delete-me') {
                if (window.confirm('Delete this message for you?')) {
                    deleteModalMessage(messageId, 'you', section);
                }
                closeAllModalActionMenus();
                return;
            }
        }

        const gotoReply = target.closest('.msg-goto-reply');
        if (gotoReply) {
            event.preventDefault();
            event.stopPropagation();
            const targetMsgId = gotoReply.getAttribute('data-scroll-to-msg');
            const sectionGoto = gotoReply.getAttribute('data-section') || 'private';
            scrollToModalMessage(targetMsgId, sectionGoto);
            return;
        }

        const reactionChoice = target.closest('.msg-private-reaction-choice');
        if (reactionChoice) {
            event.preventDefault();
            event.stopPropagation();
            const messageId = reactionChoice.getAttribute('data-message-id') || '';
            const section = reactionChoice.getAttribute('data-section') || 'private';
            const reaction = reactionChoice.getAttribute('data-reaction') || '';
            const picker = reactionChoice.closest('.msg-private-reaction-picker');
            if (picker) picker.classList.remove('show');
            closeAllModalActionMenus();
            if (messageId && reaction) reactToModalMessage(messageId, reaction, section);
            return;
        }

        const reactionChip = target.closest('.msg-private-reaction-chip');
        if (reactionChip) {
            event.preventDefault();
            event.stopPropagation();
            const messageId = reactionChip.getAttribute('data-message-id') || '';
            const section = reactionChip.getAttribute('data-section') || 'private';
            const reaction = reactionChip.getAttribute('data-reaction') || '';
            if (messageId && reaction) reactToModalMessage(messageId, reaction, section);
            return;
        }

        if (!target.closest('.msg-private-reaction-wrap') && !target.closest('#msgFloatingMenu')) {
            closeAllModalReactionPickers();
        }
        if (!target.closest('.msg-modal-actions-inline') && !target.closest('#msgFloatingMenu')) {
            closeAllModalActionMenus();
        }

        if (!clickedInteractive) {
            clearModalMessageSelection();
        }
    });
}

function clearModalMessageSelection() {
    document.querySelectorAll('[data-selectable-message].selected').forEach((el) => {
        el.classList.remove('selected');
    });
}

function closeAllModalReactionPickers() {
    document.querySelectorAll('.msg-private-reaction-picker.show').forEach((picker) => {
        picker.classList.remove('show');
    });
}

function closeAllModalActionMenus() {
    const fm = document.getElementById('msgFloatingMenu');
    if (fm) {
        fm.classList.remove('show');
        fm.innerHTML = '';
        delete fm.dataset.activeMsgId;
    }
}

function isNearBottom(container, threshold = 80) {
    if (!container) return true;
    return (container.scrollHeight - container.scrollTop - container.clientHeight) < threshold;
}

function mergeMessagesAsc(existing, incoming) {
    const map = new Map();
    (Array.isArray(existing) ? existing : []).forEach((m) => {
        if (m && m.id) map.set(String(m.id), m);
    });
    (Array.isArray(incoming) ? incoming : []).forEach((m) => {
        if (m && m.id) map.set(String(m.id), m);
    });
    return Array.from(map.values()).sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
}

function bindPrivateConversationLazyLoad() {
    const body = document.getElementById('msgPrivateConversationBody');
    if (!body || body.getAttribute('data-lazy-bound') === '1') return;
    body.setAttribute('data-lazy-bound', '1');
    body.addEventListener('scroll', () => {
        if (body.scrollTop > 120) return;
        if (!messageButtonState.privateHasMore) return;
        if (messageButtonState.privateLoadingOlder || messageButtonState.isLoadingConversation) return;
        loadPrivateConversation(true, { appendOlder: true });
    });
}

function bindGeneralConversationLazyLoad() {
    const body = document.getElementById('msgGeneralBody');
    if (!body) return;
    body.addEventListener('scroll', () => {
        if (body.scrollTop > 120) return;
        if (!messageButtonState.generalHasMore) return;
        if (messageButtonState.generalLoadingOlder || messageButtonState.isLoadingGeneral) return;
        loadGeneralMessages(true, { appendOlder: true });
    });
}

function scrollToModalMessage(msgId, section) {
    if (!msgId) return;
    const bodyId = section === 'general' ? 'msgGeneralBody' : 'msgPrivateConversationBody';
    const body = document.getElementById(bodyId);
    if (!body) return;
    const msgRow = body.querySelector(`[data-message-id="${CSS.escape(String(msgId))}"]`);
    if (!msgRow) return;
    msgRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
    msgRow.classList.add('msg-highlighted');
    setTimeout(() => msgRow.classList.remove('msg-highlighted'), 1500);
}

function renderGeneralReplyBanner() {
    const banner = document.getElementById('msgGeneralReplyBanner');
    const text = document.getElementById('msgGeneralReplyText');
    if (!banner || !text) return;

    if (!messageButtonState.generalReplyTo || !messageButtonState.generalReplyMeta) {
        banner.style.display = 'none';
        text.textContent = '';
        return;
    }

    const meta = messageButtonState.generalReplyMeta;
    const author = meta.username || 'User';
    const snippet = String(meta.message || '').trim();
    text.textContent = `Replying to ${author}: ${snippet.length > 100 ? snippet.slice(0, 100) + '...' : snippet}`;
    banner.style.display = 'flex';
}

function findModalMessageById(messageId, section) {
    const source = section === 'general'
        ? (messageButtonState.generalMessages || [])
        : (messageButtonState.privateConversationMessages || []);
    return source.find((m) => m && String(m.id) === String(messageId)) || null;
}

async function deleteModalMessage(messageId, deleteType, section) {
    try {
        const endpoint = deleteType === 'all'
            ? `/api/messages/${encodeURIComponent(messageId)}/delete-all`
            : `/api/messages/${encodeURIComponent(messageId)}/delete-for-me`;

        const resp = await fetch(endpoint, {
            method: 'DELETE',
            credentials: 'include'
        });

        let payload = null;
        try { payload = await resp.json(); } catch (_) { payload = null; }

        if (!resp.ok) {
            const msg = payload && payload.error ? payload.error : 'Failed to delete message';
            console.error(msg);
            return;
        }

        if (section === 'private') await loadPrivateConversation(true);
        else await loadGeneralMessages(true);
    } catch (err) {
        console.error('deleteModalMessage error:', err);
    }
}

async function loadPrivateContacts() {
    if (messageButtonState.isLoadingPrivate) return;
    messageButtonState.isLoadingPrivate = true;

    const list = document.getElementById('msgPrivateList');
    if (!list) {
        messageButtonState.isLoadingPrivate = false;
        return;
    }

    list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--dark-gray);">Loading contacts...</div>';

    try {
        const lastSeenPrivate = localStorage.getItem('chat_last_seen_private') || '1970-01-01T00:00:00Z';

        const [socialResp, inboxResp, unreadResp] = await Promise.all([
            fetch('/api/users/me/social', { credentials: 'include' }),
            fetch('/api/messages/private-inbox?limit=200', { credentials: 'include' }),
            fetch(`/api/messages/unread-per-user?lastSeenPrivate=${encodeURIComponent(lastSeenPrivate)}`, { credentials: 'include' })
        ]);

        const contactMap = new Map();
        const unreadPerUser = unreadResp.ok ? ((await unreadResp.json()).counts || {}) : {};
        messageButtonState.unreadPerUser = unreadPerUser;

        if (socialResp.ok) {
            const socialData = await socialResp.json();
            for (const person of (socialData.people || [])) {
                if (!person || !person.id) continue;
                if (messageButtonState.currentUser && String(person.id) === String(messageButtonState.currentUser.id)) continue;

                contactMap.set(person.id, {
                    userId: person.id,
                    username: person.username || 'User',
                    displayName: person.display_name || person.username || 'User',
                    avatar: person.profile_picture_url || '/images/default-avatar.svg',
                    relation: person.relation || '',
                    lastMessage: null,
                    lastTime: null
                });
            }
        }

        if (inboxResp.ok) {
            const inboxData = await inboxResp.json();
            for (const msg of (inboxData.messages || [])) {
                const partnerId = msg.user_id;
                if (!partnerId) continue;
                if (messageButtonState.currentUser && String(partnerId) === String(messageButtonState.currentUser.id)) continue;

                const existing = contactMap.get(partnerId);
                if (!existing) {
                    contactMap.set(partnerId, {
                        userId: partnerId,
                        username: msg.username || (msg.users && msg.users.username) || 'User',
                        displayName: msg.username || 'User',
                        avatar: (msg.users && msg.users.profile_picture_url) || '/images/default-avatar.svg',
                        relation: 'conversation',
                        lastMessage: msg.message || null,
                        lastTime: msg.created_at || null
                    });
                } else if (!existing.lastTime || new Date(msg.created_at) > new Date(existing.lastTime)) {
                    existing.lastMessage = msg.message || null;
                    existing.lastTime = msg.created_at || null;
                }
            }
        }

        const contacts = Array.from(contactMap.values()).sort((a, b) => {
            if (a.lastTime && b.lastTime) return new Date(b.lastTime) - new Date(a.lastTime);
            if (a.lastTime) return -1;
            if (b.lastTime) return 1;
            return (a.displayName || a.username).localeCompare(b.displayName || b.username);
        });

        messageButtonState.privateContacts = contacts;
        renderPrivateList();
    } catch (err) {
        console.error('Failed to load private contacts:', err);
        list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--dark-gray);">Failed to load contacts</div>';
    } finally {
        messageButtonState.isLoadingPrivate = false;
    }
}

function buildPrivateContactRow(c) {
    const preview = c.lastMessage ? `${escapeHtml(c.lastMessage).substring(0, 70)}${c.lastMessage.length > 70 ? '...' : ''}` : 'No messages yet';
    const time = c.lastTime ? formatTime(c.lastTime) : '';
    const unread = messageButtonState.unreadPerUser[c.userId] || 0;
    const uid = escapeHtml(String(c.userId));
    return `
        <div class="msg-conv-item msg-private-contact" data-user-id="${uid}">
            <img src="${escapeHtml(c.avatar)}" alt="${escapeHtml(c.displayName)}" class="msg-conv-avatar msg-private-profile-link msg-private-open-profile" data-user-id="${uid}" onerror="this.onerror=null;this.src='/images/default-avatar.svg'">
            <div class="msg-conv-info">
                <div class="msg-conv-name msg-private-profile-link msg-private-open-profile" data-user-id="${uid}">${escapeHtml(c.displayName)}</div>
                <div class="msg-conv-preview">${preview}</div>
                ${time ? `<div class="msg-private-meta"><span>${escapeHtml(time)}</span></div>` : ''}
            </div>
            <div class="msg-private-side">
                ${c.relation ? `<span class="msg-private-relation">${escapeHtml(relationLabel(c.relation))}</span>` : ''}
                ${unread > 0 ? `<span class="msg-private-unread">${unread > 99 ? '99+' : unread}</span>` : ''}
            </div>
        </div>
    `;
}

function bindPrivateContactRows(list) {
    list.querySelectorAll('.msg-private-contact:not([data-bound="1"])').forEach((el) => {
        el.setAttribute('data-bound', '1');
        el.addEventListener('click', () => {
            const uid = el.getAttribute('data-user-id');
            if (!uid) return;
            openPrivateConversation(uid);
        });
    });

    list.querySelectorAll('.msg-private-open-profile:not([data-profile-bound="1"])').forEach((el) => {
        el.setAttribute('data-profile-bound', '1');
        el.addEventListener('click', (event) => {
            event.stopPropagation();
            const uid = el.getAttribute('data-user-id');
            if (!uid) return;
            goToUserProfile(uid);
        });
    });
}

function appendPrivateContactsChunk() {
    const list = document.getElementById('msgPrivateList');
    const contacts = messageButtonState.privateContacts || [];
    if (!list || contacts.length === 0) return;

    const start = messageButtonState.privateContactsRendered || 0;
    const end = Math.min(start + PRIVATE_CONTACTS_PAGE_SIZE, contacts.length);
    if (end <= start) return;

    const chunk = contacts.slice(start, end).map(buildPrivateContactRow).join('');
    list.insertAdjacentHTML('beforeend', chunk);
    messageButtonState.privateContactsRendered = end;
    bindPrivateContactRows(list);
}

function renderPrivateList() {
    const list = document.getElementById('msgPrivateList');
    if (!list) return;

    const contacts = messageButtonState.privateContacts;
    if (!contacts || contacts.length === 0) {
        list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--dark-gray);"><i class="bi bi-people" style="font-size:2rem;opacity:0.3;display:block;margin-bottom:8px;"></i>No followers/following yet</div>';
        list.onscroll = null;
        return;
    }

    messageButtonState.privateContactsRendered = 0;
    list.innerHTML = '';
    appendPrivateContactsChunk();

    const updateLoadMoreFooter = () => {
        const hasMore = (messageButtonState.privateContactsRendered || 0) < contacts.length;
        let footer = document.getElementById('msgPrivateLoadMoreFooter');
        if (hasMore) {
            if (!footer) {
                footer = document.createElement('div');
                footer.id = 'msgPrivateLoadMoreFooter';
                footer.className = 'msg-private-load-more';
                list.appendChild(footer);
            }
            footer.textContent = `Scroll to load more (${messageButtonState.privateContactsRendered}/${contacts.length})`;
        } else if (footer) {
            footer.remove();
        }
    };

    updateLoadMoreFooter();

    // Keep appending until the list becomes scrollable (or nothing left),
    // so users on tall screens still get enough rows immediately.
    while (
        (messageButtonState.privateContactsRendered || 0) < contacts.length
        && list.scrollHeight <= list.clientHeight + 8
    ) {
        const before = messageButtonState.privateContactsRendered;
        appendPrivateContactsChunk();
        if (messageButtonState.privateContactsRendered === before) break;
        updateLoadMoreFooter();
    }

    list.onscroll = () => {
        const threshold = 120;
        if (list.scrollTop + list.clientHeight < list.scrollHeight - threshold) return;
        const before = messageButtonState.privateContactsRendered;
        appendPrivateContactsChunk();
        if (messageButtonState.privateContactsRendered !== before) updateLoadMoreFooter();
    };
}

function relationLabel(relation) {
    if (!relation) return 'Connected';
    if (String(relation).includes('mutual')) return 'Mutual';
    if (String(relation).includes('follower')) return 'Follows you';
    if (String(relation).includes('following')) return 'You follow';
    if (String(relation).includes('conversation')) return 'Conversation';
    return 'Connected';
}

function generateAnonymousName(userId) {
    const adjectives = [
        'Mystic','Shadow','Silent','Bright','Swift','Calm','Bold','Gentle','Wild','Noble',
        'Cosmic','Azure','Crimson','Golden','Jade','Luna','Solar','Stellar','Vivid','Zen',
        'Amber','Cobalt','Dusk','Ember','Frost','Ivory','Navy','Onyx','Pearl','Ruby'
    ];
    const animals = [
        'Fox','Wolf','Hawk','Bear','Deer','Lion','Owl','Raven','Seal','Tiger',
        'Crane','Drake','Eagle','Finch','Goose','Heron','Ibis','Jaguar','Koala','Lynx',
        'Mink','Newt','Orca','Panda','Quail','Robin','Stoat','Toad','Vole','Wren'
    ];
    const str = String(userId || '');
    let h1 = 0, h2 = 0, h3 = 0;
    for (let i = 0; i < str.length; i++) {
        const c = str.charCodeAt(i);
        h1 = Math.imul(h1, 31) + c | 0;
        h2 = Math.imul(h2, 37) + c | 0;
        h3 = Math.imul(h3, 41) + c | 0;
    }
    const adj = adjectives[Math.abs(h1) % 30];
    const animal = animals[Math.abs(h2) % 30];
    const num = Math.abs(h3) % 900 + 100;
    return `${adj}${animal}#${num}`;
}

function renderPrivateReplyBanner() {
    const banner = document.getElementById('msgPrivateReplyBanner');
    const text = document.getElementById('msgPrivateReplyText');
    if (!banner || !text) return;

    if (!messageButtonState.privateReplyTo || !messageButtonState.privateReplyMeta) {
        banner.style.display = 'none';
        text.textContent = '';
        return;
    }

    const meta = messageButtonState.privateReplyMeta;
    const author = meta.username || 'User';
    const snippet = String(meta.message || '').trim();
    text.textContent = `Replying to ${author}: ${snippet.length > 100 ? snippet.slice(0, 100) + '...' : snippet}`;
    banner.style.display = 'flex';
}

function buildModalReactionMarkup(msg, section) {
    const msgId = msg && msg.id ? String(msg.id) : '';
    if (!msgId) return '';

    const reactions = msg._reactions || {};
    const myReaction = msg._myReaction || null;

    const chips = MESSAGE_REACTION_TYPES
        .filter(type => Number(reactions[type] || 0) > 0)
        .map(type => {
            const count = Number(reactions[type] || 0);
            return `<button class="msg-private-reaction-chip${myReaction === type ? ' mine' : ''}" data-reaction="${type}" data-message-id="${escapeHtml(msgId)}" data-section="${escapeHtml(section)}">${MESSAGE_REACTION_EMOJIS[type]} ${count}</button>`;
        }).join('');

    if (!chips) return '';

    return `
        <div class="msg-private-reactions-row">
            ${chips}
        </div>`;
}

function buildModalActionsMenu(msgId, section, isSelf, includeReply, menuAlign) {
    return `<div class="msg-modal-actions-inline"><button class="msg-modal-more-btn" data-msg-id="${msgId}" data-section="${section}" data-is-self="${isSelf ? '1' : '0'}" data-include-reply="${includeReply ? '1' : '0'}" data-menu-align="${menuAlign}" aria-label="Message options"><i class="bi bi-three-dots-vertical"></i></button></div>`;
}

async function hydrateModalMessageReactions(messageList) {
    try {
        const list = Array.isArray(messageList) ? messageList : [];
        const ids = [...new Set(list.map(m => m && m.id).filter(Boolean).map(String))];
        if (ids.length === 0) return;

        const resp = await fetch(`/api/messages/reactions?ids=${encodeURIComponent(ids.join(','))}`, {
            credentials: 'include'
        });
        if (!resp.ok) return;

        const data = await resp.json();
        const reactionsByMessage = data.reactionsByMessage || {};
        const userReactions = data.userReactions || {};

        for (const msg of list) {
            if (!msg || !msg.id) continue;
            const key = String(msg.id);
            msg._reactions = reactionsByMessage[key] || {};
            msg._myReaction = userReactions[key] || null;
        }
    } catch (err) {
        console.warn('hydrateModalMessageReactions failed:', err && err.message ? err.message : err);
    }
}

async function reactToModalMessage(messageId, reactionType, section) {
    try {
        const resp = await fetch(`/api/messages/${encodeURIComponent(messageId)}/reactions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ reaction: reactionType })
        });

        let payload = null;
        try { payload = await resp.json(); } catch (_) { payload = null; }

        if (!resp.ok) {
            const msg = payload && payload.error ? payload.error : 'Failed to react to message';
            console.error(msg);
            return;
        }

        if (section === 'private') await loadPrivateConversation(true);
        else await loadGeneralMessages(true);
    } catch (err) {
        console.error('reactToModalMessage error:', err);
    }
}

async function openPrivateConversation(userId) {
    const selected = messageButtonState.privateContacts.find((c) => String(c.userId) === String(userId));
    if (!selected) return;

    if (messageButtonState.currentUser && String(messageButtonState.currentUser.id) === String(userId)) {
        return;
    }

    messageButtonState.activePrivateUser = {
        userId: selected.userId,
        displayName: selected.displayName,
        username: selected.username,
        avatar: selected.avatar,
        relation: selected.relation
    };
    messageButtonState.privateConversationMessages = [];
    messageButtonState.privateHasMore = true;
    messageButtonState.privateLoadingOlder = false;
    messageButtonState.privateReplyTo = null;
    messageButtonState.privateReplyMeta = null;

    renderPrivateConversationShell();
    await loadPrivateConversation(false);
    startPrivateConversationPolling();
}

function renderPrivateConversationShell() {
    const list = document.getElementById('msgPrivateList');
    const user = messageButtonState.activePrivateUser;
    if (!list || !user) return;

    list.innerHTML = `
        <div class="msg-private-chat-wrap">
            <div class="msg-private-chat-head">
                <button class="msg-private-back" id="msgPrivateBack" title="Back to contacts" aria-label="Back to contacts">
                    <i class="bi bi-arrow-left"></i>
                </button>
                <img src="${escapeHtml(user.avatar)}" class="msg-private-head-avatar msg-private-profile-link" id="msgPrivateHeaderProfile" data-user-id="${escapeHtml(String(user.userId))}" alt="${escapeHtml(user.displayName)}" onerror="this.onerror=null;this.src='/images/default-avatar.svg'">
                <div style="min-width:0;flex:1;">
                    <div class="msg-private-head-name msg-private-profile-link" id="msgPrivateHeaderName" data-user-id="${escapeHtml(String(user.userId))}">${escapeHtml(user.displayName)}</div>
                    <div class="msg-private-meta">${escapeHtml(relationLabel(user.relation))}</div>
                </div>
            </div>

            <div class="msg-private-chat-body" id="msgPrivateConversationBody">
                <div class="msg-private-empty">Loading conversation...</div>
            </div>

            <div class="msg-private-reply-banner" id="msgPrivateReplyBanner">
                <div class="msg-private-reply-text" id="msgPrivateReplyText"></div>
                <button class="msg-private-reply-cancel" id="msgPrivateReplyCancel" aria-label="Cancel reply">✕</button>
            </div>

            <div class="msg-private-composer">
                <input
                    id="msgPrivateComposerInput"
                    class="msg-private-input"
                    type="text"
                    maxlength="500"
                    placeholder="Type your message..."
                >
                <button id="msgPrivateComposerSend" class="msg-private-send" title="Send" aria-label="Send message">
                    <i class="bi bi-send-fill"></i>
                </button>
            </div>
        </div>
    `;

    const backBtn = document.getElementById('msgPrivateBack');
    if (backBtn) {
        backBtn.addEventListener('click', () => {
            messageButtonState.activePrivateUser = null;
            messageButtonState.privateReplyTo = null;
            messageButtonState.privateReplyMeta = null;
            renderPrivateReplyBanner();
            stopPrivateConversationPolling();
            loadPrivateContacts();
        });
    }

    const headerProfile = document.getElementById('msgPrivateHeaderProfile');
    const headerName = document.getElementById('msgPrivateHeaderName');
    if (headerProfile) {
        headerProfile.addEventListener('click', (event) => {
            event.stopPropagation();
            const uid = headerProfile.getAttribute('data-user-id');
            if (!uid) return;
            goToUserProfile(uid);
        });
    }
    if (headerName) {
        headerName.addEventListener('click', (event) => {
            event.stopPropagation();
            const uid = headerName.getAttribute('data-user-id');
            if (!uid) return;
            goToUserProfile(uid);
        });
    }

    const input = document.getElementById('msgPrivateComposerInput');
    const sendBtn = document.getElementById('msgPrivateComposerSend');
    const replyCancelBtn = document.getElementById('msgPrivateReplyCancel');

    if (sendBtn) sendBtn.addEventListener('click', sendPrivateMessageFromModal);
    if (replyCancelBtn) {
        replyCancelBtn.addEventListener('click', () => {
            messageButtonState.privateReplyTo = null;
            messageButtonState.privateReplyMeta = null;
            renderPrivateReplyBanner();
        });
    }
    if (input) {
        input.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                sendPrivateMessageFromModal();
            }
        });
        input.focus();
    }

    renderPrivateReplyBanner();
    bindPrivateConversationLazyLoad();
}

function startPrivateConversationPolling() {
    stopPrivateConversationPolling();

    messageButtonState.privatePollIntervalId = setInterval(() => {
        const modal = document.getElementById('messageModal');
        if (!modal || !modal.classList.contains('show')) return;
        if (messageButtonState.currentTab !== 'private') return;
        if (!messageButtonState.activePrivateUser) return;
        loadPrivateConversation(true);
    }, PRIVATE_POLL_INTERVAL_MS);
}

function stopPrivateConversationPolling() {
    if (messageButtonState.privatePollIntervalId) {
        clearInterval(messageButtonState.privatePollIntervalId);
        messageButtonState.privatePollIntervalId = null;
    }
}

async function loadPrivateConversation(silent, options = {}) {
    if (!messageButtonState.activePrivateUser) return;

    const appendOlder = !!options.appendOlder;
    if (messageButtonState.isLoadingConversation) return;
    if (appendOlder && (!messageButtonState.privateHasMore || messageButtonState.privateLoadingOlder)) return;

    messageButtonState.isLoadingConversation = true;
    if (appendOlder) messageButtonState.privateLoadingOlder = true;

    const body = document.getElementById('msgPrivateConversationBody');
    if (!body) {
        messageButtonState.isLoadingConversation = false;
        messageButtonState.privateLoadingOlder = false;
        return;
    }

    const preserveScroll = appendOlder ? true : !!silent;
    const prevScrollTop = preserveScroll ? body.scrollTop : 0;
    const prevScrollHeight = preserveScroll ? body.scrollHeight : 0;
    const shouldStickToBottom = appendOlder ? false : (preserveScroll ? isNearBottom(body) : true);

    try {
        const withId = messageButtonState.activePrivateUser.userId;
        const qs = new URLSearchParams({ with: String(withId), limit: String(PRIVATE_MESSAGES_PAGE_SIZE) });
        if (appendOlder && messageButtonState.privateConversationMessages.length > 0) {
            const oldest = messageButtonState.privateConversationMessages[0];
            if (oldest && oldest.id) qs.set('before', String(oldest.id));
        }

        const resp = await fetch(`/api/messages/private?${qs.toString()}`, { credentials: 'include' });

        if (!resp.ok) {
            if (!silent && !appendOlder) body.innerHTML = '<div class="msg-private-empty">Failed to load conversation</div>';
            return;
        }

        const data = await resp.json();
        const incoming = Array.isArray(data.messages) ? data.messages : [];
        await hydrateModalMessageReactions(incoming);

        if (appendOlder) {
            messageButtonState.privateHasMore = incoming.length >= PRIVATE_MESSAGES_PAGE_SIZE;
            messageButtonState.privateConversationMessages = mergeMessagesAsc(incoming, messageButtonState.privateConversationMessages);
        } else if (silent && messageButtonState.privateConversationMessages.length > 0) {
            messageButtonState.privateConversationMessages = mergeMessagesAsc(messageButtonState.privateConversationMessages, incoming);
        } else {
            messageButtonState.privateConversationMessages = incoming;
            messageButtonState.privateHasMore = incoming.length >= PRIVATE_MESSAGES_PAGE_SIZE;
        }

        renderPrivateConversationMessages({ preserveScroll, prevScrollTop, shouldStickToBottom });

        if (appendOlder && preserveScroll) {
            const delta = body.scrollHeight - prevScrollHeight;
            body.scrollTop = Math.max(0, prevScrollTop + delta);
        }

        localStorage.setItem('chat_last_seen_private', new Date().toISOString());
        updateMessageUnreadBadge();
    } catch (err) {
        console.error('Failed to load private conversation:', err);
        if (!silent && !appendOlder) body.innerHTML = '<div class="msg-private-empty">Error loading conversation</div>';
    } finally {
        messageButtonState.isLoadingConversation = false;
        messageButtonState.privateLoadingOlder = false;
    }
}

function renderPrivateConversationMessages(options = {}) {
    const body = document.getElementById('msgPrivateConversationBody');
    if (!body) return;

    const preserveScroll = !!options.preserveScroll;
    const prevScrollTop = Number(options.prevScrollTop || 0);
    const shouldStickToBottom = options.shouldStickToBottom !== false;

    const msgs = messageButtonState.privateConversationMessages || [];
    if (msgs.length === 0) {
        body.innerHTML = '<div class="msg-private-empty"><i class="bi bi-chat-dots" style="font-size:1.6rem;opacity:0.35;display:block;margin-bottom:8px;"></i>Start your conversation</div>';
        return;
    }

    body.innerHTML = msgs.map((msg) => {
        const isSelf = messageButtonState.currentUser && String(msg.user_id) === String(messageButtonState.currentUser.id);
        const safeMessage = escapeHtml(msg.message || '');
        const senderUsername = escapeHtml(msg.username || (messageButtonState.activePrivateUser && messageButtonState.activePrivateUser.username) || 'User');
        const partnerAvatar = (messageButtonState.activePrivateUser && messageButtonState.activePrivateUser.avatar)
            ? messageButtonState.activePrivateUser.avatar
            : '/images/default-avatar.svg';
        const avatarSrc = isSelf
            ? ((messageButtonState.currentUser && messageButtonState.currentUser.profile_picture_url) || '/images/default-avatar.svg')
            : ((msg.users && msg.users.profile_picture_url) || partnerAvatar);
        const msgId = escapeHtml(String(msg.id || ''));

        let replyPreview = '';
        if (msg.reply_to_meta) {
            const rt = msg.reply_to_meta;
            const rtUser = escapeHtml(rt.username || 'User');
            const rtText = escapeHtml(rt.message || '');
            replyPreview = `<div class="msg-private-reply-preview msg-goto-reply" data-scroll-to-msg="${escapeHtml(String(msg.reply_to || rt.id || ''))}" data-section="private" style="font-size:0.75rem;opacity:0.85;margin-bottom:6px;border-left:2px solid rgba(255,158,180,0.7);padding-left:7px;">${rtUser}: ${rtText.substring(0, 80)}${rtText.length > 80 ? '...' : ''}</div>`;
        }

        const actionsMenu = buildModalActionsMenu(msgId, 'private', !!isSelf, true, isSelf ? 'left' : 'right');
        const bubbleMarkup = `
            <div class="msg-private-bubble ${isSelf ? 'self' : 'other'}">
                ${!isSelf ? `<div class="msg-private-author">${senderUsername}</div>` : ''}
                ${replyPreview}
                <div>${safeMessage}</div>
                ${buildModalReactionMarkup(msg, 'private')}
            </div>`;
        const rowMain = isSelf
            ? `${actionsMenu}${bubbleMarkup}`
            : `${bubbleMarkup}${actionsMenu}`;

        return `
            <div class="msg-private-row ${isSelf ? 'self' : 'other'}" data-selectable-message="1" data-message-id="${msgId}">
                ${!isSelf ? `<img src="${escapeHtml(avatarSrc)}" alt="${escapeHtml(msg.username || 'User')}" class="msg-private-msg-avatar" onerror="this.onerror=null;this.src='/images/default-avatar.svg'">` : ''}
                <div class="msg-private-msg-main">
                    ${rowMain}
                </div>
            </div>
        `;
    }).join('');

    if (!preserveScroll || shouldStickToBottom) {
        body.scrollTop = body.scrollHeight;
    } else {
        const maxTop = Math.max(0, body.scrollHeight - body.clientHeight);
        body.scrollTop = Math.min(Math.max(0, prevScrollTop), maxTop);
    }
}

async function sendPrivateMessageFromModal() {
    if (messageButtonState.isSendingPrivate) return;

    const user = messageButtonState.activePrivateUser;
    const input = document.getElementById('msgPrivateComposerInput');
    const sendBtn = document.getElementById('msgPrivateComposerSend');

    if (!user || !input || !sendBtn) return;

    let message = String(input.value || '').trim();
    if (!message) return;

    message = message
        .replace(/<[^>]*>/g, '')
        .replace(/[\x00-\x1F\x7F]/g, '');
    if (message.length > 1000) message = message.substring(0, 1000);

    messageButtonState.isSendingPrivate = true;
    input.disabled = true;
    sendBtn.disabled = true;

    try {
        const response = await fetch('/api/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({
                message,
                chat_type: 'private',
                recipient_id: user.userId,
                reply_to: messageButtonState.privateReplyTo || null
            })
        });

        let payload = null;
        try {
            payload = await response.json();
        } catch (_) {
            payload = null;
        }

        if (!response.ok) {
            const errText = (payload && payload.error) ? payload.error : 'Failed to send message';
            console.error(errText);
            return;
        }

        input.value = '';
        messageButtonState.privateReplyTo = null;
        messageButtonState.privateReplyMeta = null;
        renderPrivateReplyBanner();
        const contact = messageButtonState.privateContacts.find((c) => String(c.userId) === String(user.userId));
        if (contact) {
            contact.lastMessage = message;
            contact.lastTime = new Date().toISOString();
        }
        await loadPrivateConversation(false);
    } catch (err) {
        console.error('Failed to send private message:', err);
    } finally {
        messageButtonState.isSendingPrivate = false;
        input.disabled = false;
        sendBtn.disabled = false;
        input.focus();
    }
}

async function loadGeneralMessages(preserveScroll = false, options = {}) {
    const appendOlder = !!options.appendOlder;
    if (messageButtonState.isLoadingGeneral) return;
    if (appendOlder && (!messageButtonState.generalHasMore || messageButtonState.generalLoadingOlder)) return;
    messageButtonState.isLoadingGeneral = true;
    if (appendOlder) messageButtonState.generalLoadingOlder = true;

    const list = document.getElementById('msgGeneralList');
    if (!list) {
        messageButtonState.isLoadingGeneral = false;
        messageButtonState.generalLoadingOlder = false;
        return;
    }

    const bodyEl = document.getElementById('msgGeneralBody');
    const effectivePreserve = appendOlder ? true : !!preserveScroll;
    const prevScrollTop = effectivePreserve && bodyEl ? bodyEl.scrollTop : 0;
    const prevScrollHeight = effectivePreserve && bodyEl ? bodyEl.scrollHeight : 0;
    const shouldStickToBottom = appendOlder ? false : (effectivePreserve && bodyEl ? isNearBottom(bodyEl) : true);

    try {
        const qs = new URLSearchParams({ limit: String(GENERAL_MESSAGES_PAGE_SIZE) });
        if (appendOlder && messageButtonState.generalMessages.length > 0) {
            const oldest = messageButtonState.generalMessages[0];
            if (oldest && oldest.id) qs.set('before', String(oldest.id));
        }

        const resp = await fetch(`/api/messages/general?${qs.toString()}`, { credentials: 'include' });
        if (!resp.ok) {
            list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--dark-gray);">Failed to load chat</div>';
            return;
        }

        const data = await resp.json();
        const incoming = Array.isArray(data.messages) ? data.messages : [];
        await hydrateModalMessageReactions(incoming);

        if (appendOlder) {
            messageButtonState.generalHasMore = incoming.length >= GENERAL_MESSAGES_PAGE_SIZE;
            messageButtonState.generalMessages = mergeMessagesAsc(incoming, messageButtonState.generalMessages);
        } else if (effectivePreserve && messageButtonState.generalMessages.length > 0) {
            messageButtonState.generalMessages = mergeMessagesAsc(messageButtonState.generalMessages, incoming);
        } else {
            messageButtonState.generalMessages = incoming;
            messageButtonState.generalHasMore = incoming.length >= GENERAL_MESSAGES_PAGE_SIZE;
        }

        renderGeneralChat({ preserveScroll: effectivePreserve, prevScrollTop, shouldStickToBottom });

        if (appendOlder) {
            const bodyAfter = document.getElementById('msgGeneralBody');
            if (bodyAfter) {
                const delta = bodyAfter.scrollHeight - prevScrollHeight;
                bodyAfter.scrollTop = Math.max(0, prevScrollTop + delta);
            }
        }

        localStorage.setItem('chat_last_seen_general', new Date().toISOString());
        updateMessageUnreadBadge();
    } catch (err) {
        console.error('Failed to load general messages:', err);
        list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--dark-gray);">Error loading chat</div>';
    } finally {
        messageButtonState.isLoadingGeneral = false;
        messageButtonState.generalLoadingOlder = false;
    }
}

function renderGeneralChat(options = {}) {
    const list = document.getElementById('msgGeneralList');
    if (!list) return;

    const preserveScroll = !!options.preserveScroll;
    const prevScrollTop = Number(options.prevScrollTop || 0);
    const shouldStickToBottom = options.shouldStickToBottom !== false;

    const rows = (messageButtonState.generalMessages || []).map((msg) => {
        const isSelf = messageButtonState.currentUser && String(msg.user_id) === String(messageButtonState.currentUser.id);
        const displayNameRaw = msg.is_anonymous ? (msg.username || 'Anonymous') : (msg.username || 'User');
        const displayName = escapeHtml(displayNameRaw);
        const anonBadge = msg.is_anonymous
            ? '<span style="font-size:0.65rem;color:var(--primary-pink);font-weight:600;margin-left:4px;">anonymous</span>'
            : '';
        const msgId = escapeHtml(String(msg.id || ''));

        let replyPreview = '';
        if (msg.reply_to_meta) {
            const rt = msg.reply_to_meta;
            const rtUser = escapeHtml(rt.username || 'User');
            const rtText = escapeHtml(rt.message || '');
            replyPreview = `<div class="msg-goto-reply" data-scroll-to-msg="${escapeHtml(String(msg.reply_to || rt.id || ''))}" data-section="general" style="font-size:0.74rem;opacity:0.8;margin:6px 0;border-left:2px solid rgba(255,158,180,0.7);padding-left:7px;">${rtUser}: ${rtText.substring(0, 80)}${rtText.length > 80 ? '...' : ''}</div>`;
        }

        const actionsMenu = buildModalActionsMenu(msgId, 'general', !!isSelf, true, isSelf ? 'left' : 'right');
        const safeMessage = escapeHtml(String(msg.message || ''));
        const displayAvatar = msg.is_anonymous
            ? '/images/default-avatar.svg'
            : (((msg.users && msg.users.profile_picture_url) || (isSelf ? (messageButtonState.currentUser && messageButtonState.currentUser.profile_picture_url) : null) || '/images/default-avatar.svg'));
        const messageBubble = `
            <div class="msg-private-bubble ${isSelf ? 'self' : 'other'}">
                ${!isSelf ? `<div class="msg-private-author">${displayName}${anonBadge}</div>` : ''}
                ${replyPreview}
                <div style="white-space:pre-wrap;">${safeMessage}</div>
                ${buildModalReactionMarkup(msg, 'general')}
            </div>`;
        const rowMain = isSelf
            ? `${actionsMenu}${messageBubble}`
            : `${messageBubble}${actionsMenu}`;

        return `
            <div class="msg-general-row ${isSelf ? 'self' : 'other'}" data-selectable-message="1" data-message-id="${msgId}">
                ${!isSelf ? `<img src="${escapeHtml(displayAvatar)}" alt="${displayName}" class="msg-private-msg-avatar" onerror="this.onerror=null;this.src='/images/default-avatar.svg'">` : ''}
                <div class="msg-private-msg-main">
                    ${rowMain}
                </div>
            </div>
        `;
    }).join('');

    const emptyState = '<div class="msg-private-empty"><i class="bi bi-chat-heart" style="font-size:1.6rem;opacity:0.35;display:block;margin-bottom:8px;"></i>No messages yet</div>';

    list.innerHTML = `
        <div class="msg-general-chat-wrap">
            <div class="msg-general-body" id="msgGeneralBody">
                ${rows || emptyState}
            </div>
            <div class="msg-general-composer-wrap">
                <div class="msg-private-reply-banner" id="msgGeneralReplyBanner">
                    <div class="msg-private-reply-text" id="msgGeneralReplyText"></div>
                    <button class="msg-private-reply-cancel" id="msgGeneralReplyCancel" aria-label="Cancel reply">✕</button>
                </div>
                <div class="msg-general-anon-row">
                    <button id="msgGeneralAnonToggle" class="msg-general-anon-toggle${messageButtonState.generalAnonMode ? ' active' : ''}">
                        <i class="bi bi-incognito"></i>
                        ${messageButtonState.generalAnonMode ? 'Anonymous On' : 'Anonymous Off'}
                    </button>
                </div>
                <div class="msg-general-anon-banner" id="msgGeneralAnonBanner"></div>
                <div class="msg-general-composer">
                    <input id="msgGeneralInput" class="msg-general-input" type="text" maxlength="1000" placeholder="Type a message to everyone...">
                    <button id="msgGeneralSend" class="msg-general-send" title="Send" aria-label="Send message">
                        <i class="bi bi-send-fill"></i>
                    </button>
                </div>
            </div>
        </div>
    `;

    const anonToggleBtn = document.getElementById('msgGeneralAnonToggle');
    const sendBtn = document.getElementById('msgGeneralSend');
    const input = document.getElementById('msgGeneralInput');
    const body = document.getElementById('msgGeneralBody');

    if (anonToggleBtn) {
        anonToggleBtn.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            messageButtonState.generalAnonMode = !messageButtonState.generalAnonMode;
            renderGeneralAnonBanner();
        });
    }

    const generalReplyCancel = document.getElementById('msgGeneralReplyCancel');
    if (generalReplyCancel) {
        generalReplyCancel.addEventListener('click', () => {
            messageButtonState.generalReplyTo = null;
            messageButtonState.generalReplyMeta = null;
            renderGeneralReplyBanner();
        });
    }

    if (sendBtn) sendBtn.addEventListener('click', sendGeneralMessageFromModal);
    if (input) {
        input.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                sendGeneralMessageFromModal();
            }
        });
    }

    renderGeneralAnonBanner();
    renderGeneralReplyBanner();
    bindGeneralConversationLazyLoad();
    if (body) {
        if (!preserveScroll || shouldStickToBottom) {
            body.scrollTop = body.scrollHeight;
        } else {
            const maxTop = Math.max(0, body.scrollHeight - body.clientHeight);
            body.scrollTop = Math.min(Math.max(0, prevScrollTop), maxTop);
        }
    }
}

function renderGeneralAnonBanner() {
    const banner = document.getElementById('msgGeneralAnonBanner');
    const toggleBtn = document.getElementById('msgGeneralAnonToggle');
    const input = document.getElementById('msgGeneralInput');
    if (!banner || !toggleBtn || !input) return;

    if (messageButtonState.generalAnonMode) {
        const anonName = generateAnonymousName(messageButtonState.currentUser && messageButtonState.currentUser.id);
        toggleBtn.classList.add('active');
        toggleBtn.innerHTML = '<i class="bi bi-incognito"></i> Anonymous On';
        banner.style.display = 'none';
        banner.textContent = '';
        input.placeholder = `Sending as ${anonName}`;
    } else {
        toggleBtn.classList.remove('active');
        toggleBtn.innerHTML = '<i class="bi bi-incognito"></i> Anonymous Off';
        banner.style.display = 'none';
        banner.textContent = '';
        input.placeholder = 'Type a message to everyone...';
    }
}

async function sendGeneralMessageFromModal() {
    if (messageButtonState.isSendingGeneral) return;

    const input = document.getElementById('msgGeneralInput');
    const sendBtn = document.getElementById('msgGeneralSend');
    if (!input || !sendBtn) return;

    let message = String(input.value || '').trim();
    if (!message) return;

    message = message
        .replace(/<[^>]*>/g, '')
        .replace(/[\x00-\x1F\x7F]/g, '');
    if (message.length > 1000) message = message.substring(0, 1000);

    messageButtonState.isSendingGeneral = true;
    input.disabled = true;
    sendBtn.disabled = true;

    try {
        const response = await fetch('/api/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({
                message,
                chat_type: 'general',
                is_anonymous: messageButtonState.generalAnonMode === true,
                reply_to: messageButtonState.generalReplyTo || null
            })
        });

        let payload = null;
        try {
            payload = await response.json();
        } catch (_) {
            payload = null;
        }

        if (!response.ok) {
            const errText = (payload && payload.error) ? payload.error : 'Failed to send message';
            console.error(errText);
            return;
        }

        input.value = '';
        messageButtonState.generalReplyTo = null;
        messageButtonState.generalReplyMeta = null;
        await loadGeneralMessages();
    } catch (err) {
        console.error('Failed to send general message:', err);
    } finally {
        messageButtonState.isSendingGeneral = false;
        input.disabled = false;
        sendBtn.disabled = false;
        input.focus();
    }
}

function formatTime(value) {
    try {
        const d = new Date(value);
        if (Number.isNaN(d.getTime())) return '';
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch (_) {
        return '';
    }
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text == null ? '' : String(text);
    return div.innerHTML;
}

function goToUserProfile(userId) {
    if (!userId) return;
    window.location.href = `/user.html?user=${encodeURIComponent(String(userId))}`;
}

document.addEventListener('DOMContentLoaded', () => {
    try {
        initMessageButton();
    } catch (err) {
        console.error('Error initializing message button:', err);
    }
});

document.addEventListener('DOMContentLoaded', () => {
    const modal = document.getElementById('messageModal');
    if (!modal) return;

    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeMessageModal();
    });
});
