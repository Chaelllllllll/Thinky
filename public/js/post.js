(function () {
    const params = new URLSearchParams(window.location.search);
    const postId = params.get('id') || params.get('postId');

    const loadingEl = document.getElementById('postLoading');
    const mainEl = document.getElementById('postMain');
    const errorEl = document.getElementById('postError');
    const titleEl = document.getElementById('postTitle');
    const dateEl = document.getElementById('postDate');
    const authorEl = document.getElementById('postAuthor');
    const contentEl = document.getElementById('postContent');
    const reactionBar = document.getElementById('postReactionBar');
    const commentsHeader = document.getElementById('postCommentsHeader');
    const commentsList = document.getElementById('postCommentsList');
    const commentInput = document.getElementById('postCommentInput');
    const commentSendBtn = document.getElementById('postCommentSendBtn');
    const postShareBtn = document.getElementById('postShareBtn');
    const postShareBtnInline = document.getElementById('postShareBtnInline');
    const postBackBtn = document.getElementById('postBackBtn');
    const postCommentAvatar = document.getElementById('postCommentAvatar');

    let currentPost = null;
    let currentUserId = null;
    let isAdmin = false;
    let shareUrl = '';
    let allComments = [];
    let displayedComments = [];
    const COMMENTS_PER_PAGE = 5;

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text || '';
        return div.innerHTML;
    }

    function stripHtml(html) {
        const tmp = document.createElement('div');
        tmp.innerHTML = html || '';
        return tmp.textContent || tmp.innerText || '';
    }

    function setLoading(visible) {
        if (loadingEl) loadingEl.style.display = visible ? 'block' : 'none';
        if (mainEl) mainEl.style.display = visible ? 'none' : 'block';
        if (errorEl) errorEl.style.display = 'none';
    }

    function showError(message) {
        if (loadingEl) loadingEl.style.display = 'none';
        if (mainEl) mainEl.style.display = 'none';
        if (errorEl) {
            errorEl.textContent = message || 'Post not found.';
            errorEl.style.display = 'block';
        }
    }

    function renderAuthor(post) {
        const authorName = post.users?.display_name || post.users?.username || 'Unknown';
        const authorAvatar = post.users?.profile_picture_url || post.users?.avatar_url || '/images/default-avatar.svg';
        const verifiedBadge = (post.users?.is_admin || post.users?.role === 'admin') ? '<i class="bi bi-check-circle-fill" style="font-size:0.7rem;margin-left:4px;color:var(--primary-pink);vertical-align:middle;" title="Verified Admin"></i>' : '';
        if (!authorEl) return;
        authorEl.innerHTML = `
            <a href="/user.html?user=${encodeURIComponent(post.user_id)}" style="display:flex;align-items:center;gap:12px;text-decoration:none;color:inherit;min-width:0;">
                <img src="${escapeHtml(authorAvatar)}" alt="${escapeHtml(authorName)}" onerror="this.src='/images/default-avatar.svg'">
                <div style="min-width:0;">
                    <div class="post-author-name" style="display:flex;align-items:center;gap:4px;">${escapeHtml(authorName)}${verifiedBadge}</div>
                    <div class="post-author-handle">@${escapeHtml(post.users?.username || '')}</div>
                </div>
            </a>
        `;
    }

    function renderReactions(post) {
        if (!reactionBar) return;
        const reactions = post.reactions || [];
        const heartReactions = reactions.filter(r => r.reaction_type === 'heart');
        const count = heartReactions.length;
        const reacted = heartReactions.some(r => String(r.user_id) === String(currentUserId));
        reactionBar.innerHTML = `
            <button class="heart-btn ${reacted ? 'hearted' : ''}" id="postHeartBtn" type="button" aria-label="Heart post">
                <i class="bi ${reacted ? 'bi-heart-fill' : 'bi-heart'}" id="postHeartIcon"></i>
                <span id="postHeartCount">${count}</span>
            </button>
        `;
        const heartBtn = document.getElementById('postHeartBtn');
        if (heartBtn) heartBtn.onclick = toggleReaction;
    }

    function renderComments(post) {
        if (!commentsList) return;
        allComments = post.comments || [];
        displayedComments = allComments.slice(0, COMMENTS_PER_PAGE);
        
        if (!allComments.length) {
            commentsList.innerHTML = '<div class="comments-empty">No comments yet. Be the first!</div>';
        } else {
            const commentsHTML = displayedComments.map(comment => renderCommentThread(comment)).join('');
            let html = commentsHTML;
            
            // Add "Load more" button if there are more comments
            if (displayedComments.length < allComments.length) {
                const remaining = allComments.length - displayedComments.length;
                html += `<button class="load-more-comments-btn" style="width: 100%; padding: 12px; background: transparent; border: 1px solid rgba(233, 30, 140, 0.14); border-radius: 12px; color: var(--primary-pink); font-weight: 600; cursor: pointer; margin-top: 16px;">Load ${remaining} more comment${remaining > 1 ? 's' : ''}</button>`;
            }
            
            commentsList.innerHTML = html;
            
            // Attach event listener for load more button
            const loadMoreBtn = commentsList.querySelector('.load-more-comments-btn');
            if (loadMoreBtn) {
                loadMoreBtn.onclick = loadMoreComments;
            }
            
            attachCommentEventListeners();
        }
        if (commentsHeader) commentsHeader.textContent = `Comments (${allComments.length})`;
    }

    function loadMoreComments() {
        const newCount = displayedComments.length + COMMENTS_PER_PAGE;
        displayedComments = allComments.slice(0, newCount);
        renderComments({ comments: allComments });
    }

    function renderCommentThread(comment) {
        const commentDate = new Date(comment.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        const commentAvatar = comment.users?.profile_picture_url || comment.users?.avatar_url || '/images/default-avatar.svg';
        const commentName = comment.users?.display_name || comment.users?.username || 'Unknown';
        const reactions = comment.reactions || [];
        const heartCount = reactions.filter(r => r.reaction_type === 'heart').length;
        const userHearted = reactions.some(r => r.reaction_type === 'heart' && String(r.user_id) === String(currentUserId));
        const replies = comment.replies || [];
        const commentVerifiedBadge = (comment.users?.is_admin || comment.users?.role === 'admin') ? '<i class="bi bi-check-circle-fill" style="font-size:0.6rem;margin-left:4px;color:var(--primary-pink);vertical-align:middle;" title="Verified Admin"></i>' : '';
        
        let repliesHTML = '';
        if (replies.length > 0) {
            repliesHTML = '<div class="comment-replies">' + replies.map(reply => renderCommentReply(reply, comment.id)).join('') + '</div>';
        }
        
        const deleteBtn = (currentUserId === comment.user_id || isAdmin) ? `<button class="comment-delete-btn" data-comment-id="${comment.id}" title="Delete comment"><i class="bi bi-trash"></i></button>` : '';
        
        return `
            <div class="comment-item" data-comment-id="${comment.id}">
                <img src="${escapeHtml(commentAvatar)}" alt="${escapeHtml(commentName)}" class="comment-avatar" onerror="this.src='/images/default-avatar.svg'">
                <div class="comment-body">
                    <div class="comment-bubble">
                        <div class="comment-user" style="display:flex;align-items:center;gap:4px;">${escapeHtml(commentName)}${commentVerifiedBadge}</div>
                        <div class="comment-text">${escapeHtml(comment.comment)}</div>
                    </div>
                    <div class="comment-footer">
                        <span class="comment-time">${commentDate}</span>
                        <button class="comment-reaction-btn comment-heart-btn" data-comment-id="${comment.id}" ${!currentUserId ? 'disabled' : ''}>
                            <i class="bi ${userHearted ? 'bi-heart-fill' : 'bi-heart'}"></i>
                            <span>${heartCount > 0 ? heartCount : ''}</span>
                        </button>
                        <button class="comment-reply-btn" data-comment-id="${comment.id}" ${!currentUserId ? 'disabled' : ''}>Reply</button>
                        ${deleteBtn}
                    </div>
                </div>
            </div>
            ${repliesHTML}
        `;
    }

    function renderCommentReply(reply, parentId) {
        const replyDate = new Date(reply.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        const replyAvatar = reply.users?.profile_picture_url || reply.users?.avatar_url || '/images/default-avatar.svg';
        const replyName = reply.users?.display_name || reply.users?.username || 'Unknown';
        const reactions = reply.reactions || [];
        const heartCount = reactions.filter(r => r.reaction_type === 'heart').length;
        const userHearted = reactions.some(r => r.reaction_type === 'heart' && String(r.user_id) === String(currentUserId));
        const replyVerifiedBadge = (reply.users?.is_admin || reply.users?.role === 'admin') ? '<i class="bi bi-check-circle-fill" style="font-size:0.6rem;margin-left:4px;color:var(--primary-pink);vertical-align:middle;" title="Verified Admin"></i>' : '';
        
        const deleteBtn = (currentUserId === reply.user_id || isAdmin) ? `<button class="comment-delete-btn" data-comment-id="${reply.id}" title="Delete reply"><i class="bi bi-trash"></i></button>` : '';
        
        return `
            <div class="comment-item comment-reply-item" data-comment-id="${reply.id}" style="margin-left: 24px;">
                <img src="${escapeHtml(replyAvatar)}" alt="${escapeHtml(replyName)}" class="comment-avatar" onerror="this.src='/images/default-avatar.svg'">
                <div class="comment-body">
                    <div class="comment-bubble">
                        <div class="comment-user" style="display:flex;align-items:center;gap:4px;">${escapeHtml(replyName)}${replyVerifiedBadge}</div>
                        <div class="comment-text">${escapeHtml(reply.comment)}</div>
                    </div>
                    <div class="comment-footer">
                        <span class="comment-time">${replyDate}</span>
                        <button class="comment-reaction-btn comment-heart-btn" data-comment-id="${reply.id}" ${!currentUserId ? 'disabled' : ''}>
                            <i class="bi ${userHearted ? 'bi-heart-fill' : 'bi-heart'}"></i>
                            <span>${heartCount > 0 ? heartCount : ''}</span>
                        </button>
                        ${deleteBtn}
                    </div>
                </div>
            </div>
        `;
    }

    function attachCommentEventListeners() {
        // Heart reactions
        document.querySelectorAll('.comment-heart-btn').forEach(btn => {
            btn.onclick = (e) => {
                e.preventDefault();
                toggleCommentReaction(btn.dataset.commentId, 'heart');
            };
        });
        
        // Delete buttons
        document.querySelectorAll('.comment-delete-btn').forEach(btn => {
            btn.onclick = (e) => {
                e.preventDefault();
                if (confirm('Delete this comment?')) {
                    deleteComment(btn.dataset.commentId);
                }
            };
        });
        
        // Reply buttons
        document.querySelectorAll('.comment-reply-btn').forEach(btn => {
            btn.onclick = (e) => {
                e.preventDefault();
                const commentId = btn.dataset.commentId;
                openReplyComposer(commentId);
            };
        });
    }

    async function toggleCommentReaction(commentId, reactionType) {
        if (!currentPost?.id || !currentUserId) return;
        
        // Find the comment in allComments and update optimistically
        let targetComment = null;
        for (let comment of allComments) {
            if (comment.id === commentId) {
                targetComment = comment;
                break;
            }
            if (comment.replies) {
                for (let reply of comment.replies) {
                    if (reply.id === commentId) {
                        targetComment = reply;
                        break;
                    }
                }
            }
        }
        
        if (!targetComment) return;
        
        // Optimistic update
        const reactions = targetComment.reactions || [];
        const reacted = reactions.some(r => r.reaction_type === reactionType && String(r.user_id) === String(currentUserId));
        
        if (reacted) {
            targetComment.reactions = reactions.filter(r => !(r.reaction_type === reactionType && String(r.user_id) === String(currentUserId)));
        } else {
            targetComment.reactions.push({ user_id: currentUserId, reaction_type: reactionType });
        }
        
        // Update UI
        const commentItem = document.querySelector(`[data-comment-id="${commentId}"]`);
        if (commentItem) {
            const heartBtn = commentItem.querySelector('.comment-heart-btn');
            if (heartBtn) {
                const newHeartReactions = targetComment.reactions.filter(r => r.reaction_type === 'heart');
                const heartCount = newHeartReactions.length;
                const userHearted = newHeartReactions.some(r => String(r.user_id) === String(currentUserId));
                const icon = heartBtn.querySelector('i');
                const countSpan = heartBtn.querySelector('span');
                
                if (icon) {
                    icon.classList.toggle('bi-heart-fill', userHearted);
                    icon.classList.toggle('bi-heart', !userHearted);
                }
                if (countSpan) countSpan.textContent = heartCount > 0 ? heartCount : '';
            }
        }
        
        // Send request in background
        fetch(`/api/posts/${encodeURIComponent(currentPost.id)}/comments/${encodeURIComponent(commentId)}/reactions`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reaction_type: reactionType })
        }).catch(error => {
            console.error('Comment reaction error', error);
            window.showAlert && window.showAlert('error', 'Failed to react to comment');
            loadPost();
        });
    }

    function openReplyComposer(commentId) {
        // Find or create reply input box
        let existingReplyBox = document.querySelector(`[data-reply-to="${commentId}"]`);
        if (existingReplyBox) {
            existingReplyBox.querySelector('textarea').focus();
            return;
        }
        
        const replyBox = document.createElement('div');
        replyBox.className = 'comment-reply-composer';
        replyBox.dataset.replyTo = commentId;
        replyBox.innerHTML = `
            <div style="margin-left: 24px;">
                <div class="comment-input-wrap" style="margin-top: 12px; display: flex; gap: 8px;">
                    <textarea class="reply-input" placeholder="Write a reply..." maxlength="1000" style="flex: 1; min-height: 36px; border-radius: 12px; border: 1px solid var(--medium-gray); resize: vertical; padding: 8px 12px;"></textarea>
                    <button class="reply-send-btn" style="width: 36px; height: 36px; border-radius: 999px; border: none; background: var(--gradient-primary); color: white; cursor: pointer;"><i class="bi bi-send-fill"></i></button>
                    <button class="reply-cancel-btn" style="width: 36px; height: 36px; border-radius: 999px; border: 1px solid var(--medium-gray); background: white; color: var(--dark-gray); cursor: pointer;"><i class="bi bi-x"></i></button>
                </div>
            </div>
        `;
        
        const targetComment = document.querySelector(`[data-comment-id="${commentId}"]`);
        if (targetComment) {
            targetComment.parentNode.insertBefore(replyBox, targetComment.nextSibling);
        }
        
        const replyInput = replyBox.querySelector('.reply-input');
        const replySendBtn = replyBox.querySelector('.reply-send-btn');
        const replyCancelBtn = replyBox.querySelector('.reply-cancel-btn');
        
        replyInput.focus();
        
        replySendBtn.onclick = () => submitReply(commentId, replyInput.value, replyBox);
        replyCancelBtn.onclick = () => replyBox.remove();
    }

    async function submitReply(commentId, content, replyBox) {
        if (!currentPost?.id || !currentUserId) return;
        const cleanContent = String(content).trim();
        if (!cleanContent) return;
        
        try {
            const resp = await fetch(`/api/posts/${encodeURIComponent(currentPost.id)}/comments/${encodeURIComponent(commentId)}/replies`, {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ comment: cleanContent })
            });
            if (resp.status === 401) {
                window.location.href = '/login?next=' + encodeURIComponent(window.location.pathname + window.location.search);
                return;
            }
            if (!resp.ok) throw new Error('Failed to add reply');
            
            const data = await resp.json();
            const newReply = data.reply;
            
            // Find parent comment and add reply
            for (let comment of allComments) {
                if (comment.id === commentId) {
                    if (!comment.replies) comment.replies = [];
                    comment.replies.unshift(newReply);
                    break;
                }
            }
            
            replyBox.remove();
            renderComments({ comments: allComments });
            window.showAlert && window.showAlert('success', 'Reply added!', 2000);
        } catch (error) {
            console.error('Submit reply error', error);
            window.showAlert && window.showAlert('error', 'Failed to add reply');
        }
    }

    async function deleteComment(commentId) {
        if (!currentPost?.id) return;
        try {
            const resp = await fetch(`/api/posts/${encodeURIComponent(currentPost.id)}/comments/${encodeURIComponent(commentId)}`, {
                method: 'DELETE',
                credentials: 'include'
            });
            if (resp.status === 401) {
                window.location.href = '/login?next=' + encodeURIComponent(window.location.pathname + window.location.search);
                return;
            }
            if (!resp.ok) throw new Error('Failed to delete comment');
            
            // Remove from allComments
            let found = false;
            for (let i = 0; i < allComments.length; i++) {
                if (allComments[i].id === commentId) {
                    allComments.splice(i, 1);
                    found = true;
                    break;
                }
                if (allComments[i].replies) {
                    for (let j = 0; j < allComments[i].replies.length; j++) {
                        if (allComments[i].replies[j].id === commentId) {
                            allComments[i].replies.splice(j, 1);
                            found = true;
                            break;
                        }
                    }
                }
                if (found) break;
            }
            
            // Re-render
            renderComments({ comments: allComments });
            window.showAlert && window.showAlert('success', 'Comment deleted', 2000);
        } catch (error) {
            console.error('Delete comment error', error);
            window.showAlert && window.showAlert('error', 'Failed to delete comment');
        }
    }

    function updateShareUrl() {
        shareUrl = `${window.location.origin}/post.html?id=${encodeURIComponent(postId)}`;
    }

    function bindControls() {
        if (postBackBtn) postBackBtn.onclick = () => window.history.length > 1 ? window.history.back() : (window.location.href = '/');
        const shareTargets = [postShareBtn, postShareBtnInline].filter(Boolean);
        shareTargets.forEach(btn => {
            btn.onclick = () => {
                if (navigator.share) {
                    navigator.share({ title: currentPost?.title || 'Thinky Post', url: shareUrl }).catch(() => {});
                } else {
                    const textarea = document.createElement('textarea');
                    textarea.value = shareUrl;
                    document.body.appendChild(textarea);
                    textarea.select();
                    try {
                        document.execCommand('copy');
                        window.showAlert && window.showAlert('success', 'Link copied to clipboard!', 3000);
                    } catch (err) {
                        window.showAlert && window.showAlert('error', 'Failed to copy link', 3000);
                    }
                    document.body.removeChild(textarea);
                }
            };
        });
        if (commentSendBtn) commentSendBtn.onclick = submitComment;
    }

    async function loadCurrentUser() {
        try {
            const resp = await fetch('/api/auth/me', { credentials: 'include' });
            if (!resp.ok) return;
            const data = await resp.json();
            currentUserId = data.user?.id || null;
            isAdmin = data.user?.is_admin || data.user?.is_dev || false;
            if (postCommentAvatar) {
                postCommentAvatar.src = data.user?.profile_picture_url || '/images/default-avatar.svg';
            }
        } catch (e) {
            currentUserId = null;
            isAdmin = false;
        }
    }

    async function loadPost() {
        if (!postId) {
            showError('Post not found.');
            return;
        }
        setLoading(true);
        try {
            const resp = await fetch(`/api/posts/${encodeURIComponent(postId)}`);
            if (!resp.ok) throw new Error('Failed to load post');
            const data = await resp.json();
            currentPost = data.post || data;
            titleEl.textContent = currentPost.title || 'Post';
            dateEl.textContent = currentPost.created_at ? new Date(currentPost.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
            renderAuthor(currentPost);
            if (contentEl) {
                contentEl.innerHTML = currentPost.content || '';
                contentEl.querySelectorAll('pre').forEach(pre => {
                    if (typeof hljs !== 'undefined') {
                        const code = pre.querySelector('code') || pre;
                        if (code && !code.dataset.highlighted) hljs.highlightElement(code);
                    }
                });
            }
            renderReactions(currentPost);
            renderComments(currentPost);
            updateShareUrl();
            bindControls();
            mainEl.style.display = 'block';
        } catch (error) {
            console.error('Failed to load post', error);
            showError('Failed to load post.');
        } finally {
            if (loadingEl) loadingEl.style.display = 'none';
        }
    }

    async function toggleReaction() {
        if (!currentPost?.id) return;
        
        // Optimistic update
        const reactions = currentPost.reactions || [];
        const heartReactions = reactions.filter(r => r.reaction_type === 'heart');
        const reacted = heartReactions.some(r => String(r.user_id) === String(currentUserId));
        
        // Update UI immediately
        const heartBtn = document.getElementById('postHeartBtn');
        const heartIcon = document.getElementById('postHeartIcon');
        const heartCount = document.getElementById('postHeartCount');
        
        if (reacted) {
            // Remove reaction optimistically
            currentPost.reactions = reactions.filter(r => !(r.reaction_type === 'heart' && String(r.user_id) === String(currentUserId)));
            if (heartBtn) heartBtn.classList.remove('hearted');
            if (heartIcon) {
                heartIcon.classList.remove('bi-heart-fill');
                heartIcon.classList.add('bi-heart');
            }
        } else {
            // Add reaction optimistically
            currentPost.reactions.push({ user_id: currentUserId, reaction_type: 'heart' });
            if (heartBtn) heartBtn.classList.add('hearted');
            if (heartIcon) {
                heartIcon.classList.add('bi-heart-fill');
                heartIcon.classList.remove('bi-heart');
            }
        }
        
        // Update count
        const newHeartReactions = currentPost.reactions.filter(r => r.reaction_type === 'heart');
        if (heartCount) heartCount.textContent = newHeartReactions.length;
        
        // Send request (don't await, let it complete in background)
        fetch(`/api/posts/${encodeURIComponent(currentPost.id)}/reactions`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reaction_type: 'heart' })
        }).catch(error => {
            console.error('Toggle reaction error', error);
            window.showAlert && window.showAlert('error', 'Failed to react to post');
            // Reload on error
            loadPost();
        });
    }

    async function submitComment() {
        if (!currentPost?.id) return;
        const content = String(commentInput?.value || '').trim();
        if (!content) return;
        
        // Disable button while submitting
        if (commentSendBtn) commentSendBtn.disabled = true;
        
        try {
            const resp = await fetch(`/api/posts/${encodeURIComponent(currentPost.id)}/comments`, {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ comment: content })
            });
            
            if (resp.status === 401) {
                if (commentSendBtn) commentSendBtn.disabled = false;
                window.location.href = '/login?next=' + encodeURIComponent(window.location.pathname + window.location.search);
                return;
            }
            
            if (!resp.ok) throw new Error('Failed to add comment');
            
            const data = await resp.json();
            const newComment = data.comment;
            
            // Add to allComments
            if (newComment) {
                allComments.unshift(newComment);
                displayedComments = allComments.slice(0, COMMENTS_PER_PAGE);
                
                // Re-render comments
                renderComments({ comments: allComments });
                
                // Clear input
                if (commentInput) commentInput.value = '';
                
                window.showAlert && window.showAlert('success', 'Comment added!', 2000);
            }
        } catch (error) {
            console.error('Submit comment error', error);
            window.showAlert && window.showAlert('error', 'Failed to add comment');
        } finally {
            if (commentSendBtn) commentSendBtn.disabled = false;
        }
    }

    window.togglePostReaction = toggleReaction;
    window.submitPostComment = submitComment;

    if (!postId) {
        showError('Post not found.');
        return;
    }

    Promise.all([loadCurrentUser(), loadPost()]).then(() => {
        if (loadingEl) loadingEl.style.display = 'none';
    });
})();
