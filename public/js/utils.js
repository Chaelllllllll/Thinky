/**
 * Shared Utility Functions
 * Common utilities used across multiple client-side scripts
 */

(function() {
    'use strict';

    // =====================================================
    // STRING UTILITIES
    // =====================================================

    /**
     * Safely escape HTML to prevent XSS attacks
     * Uses DOM-based escaping for maximum safety
     */
    function escapeHtml(text) {
        if (text === null || text === undefined) return '';
        const div = document.createElement('div');
        div.textContent = String(text);
        return div.innerHTML;
    }

    /**
     * Truncate text to specified length with ellipsis
     */
    function truncateText(text, maxLength = 100) {
        if (!text || typeof text !== 'string') return '';
        if (text.length <= maxLength) return text;
        return text.slice(0, maxLength - 3) + '...';
    }

    /**
     * Capitalize first letter of string
     */
    function capitalize(str) {
        if (!str || typeof str !== 'string') return '';
        return str.charAt(0).toUpperCase() + str.slice(1);
    }

    // =====================================================
    // DATE/TIME UTILITIES
    // =====================================================

    /**
     * Format date/time for display
     */
    function formatTime(dateStr) {
        if (!dateStr) return '';
        const date = new Date(dateStr);
        if (isNaN(date.getTime())) return '';
        
        const now = new Date();
        const diff = now - date;
        const diffMinutes = Math.floor(diff / 60000);
        const diffHours = Math.floor(diff / 3600000);
        const diffDays = Math.floor(diff / 86400000);
        
        if (diffMinutes < 1) return 'Just now';
        if (diffMinutes < 60) return `${diffMinutes}m ago`;
        if (diffHours < 24) return `${diffHours}h ago`;
        if (diffDays < 7) return `${diffDays}d ago`;
        
        return date.toLocaleDateString();
    }

    /**
     * Format date for display (date only)
     */
    function formatDate(dateStr) {
        if (!dateStr) return '';
        const date = new Date(dateStr);
        if (isNaN(date.getTime())) return '';
        return date.toLocaleDateString();
    }

    /**
     * Format date and time for display
     */
    function formatDateTime(dateStr) {
        if (!dateStr) return '';
        const date = new Date(dateStr);
        if (isNaN(date.getTime())) return '';
        return date.toLocaleString();
    }

    // =====================================================
    // VALIDATION UTILITIES
    // =====================================================

    const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    function isValidUUID(str) {
        return typeof str === 'string' && UUID_REGEX.test(str);
    }

    function isValidEmail(str) {
        return typeof str === 'string' && str.length <= 255 && EMAIL_REGEX.test(str);
    }

    // =====================================================
    // HTTP/API UTILITIES
    // =====================================================

    /**
     * Wrapper for fetch with timeout and error handling
     */
    async function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        try {
            const response = await fetch(url, {
                ...options,
                signal: controller.signal,
                credentials: options.credentials || 'include'
            });
            clearTimeout(timeoutId);
            return response;
        } catch (error) {
            clearTimeout(timeoutId);
            if (error.name === 'AbortError') {
                throw new Error('Request timed out');
            }
            throw error;
        }
    }

    /**
     * Parse JSON response with error handling
     */
    async function parseJsonResponse(response) {
        try {
            return await response.json();
        } catch (e) {
            return null;
        }
    }

    // =====================================================
    // DOM UTILITIES
    // =====================================================

    /**
     * Debounce function calls
     */
    function debounce(func, wait = 300) {
        let timeout;
        return function executedFunction(...args) {
            const later = () => {
                clearTimeout(timeout);
                func.apply(this, args);
            };
            clearTimeout(timeout);
            timeout = setTimeout(later, wait);
        };
    }

    /**
     * Throttle function calls
     */
    function throttle(func, limit = 300) {
        let inThrottle;
        return function(...args) {
            if (!inThrottle) {
                func.apply(this, args);
                inThrottle = true;
                setTimeout(() => inThrottle = false, limit);
            }
        };
    }

    // =====================================================
    // EXPORT TO WINDOW
    // =====================================================

    window.ThinkyUtils = {
        escapeHtml,
        truncateText,
        capitalize,
        formatTime,
        formatDate,
        formatDateTime,
        isValidUUID,
        isValidEmail,
        fetchWithTimeout,
        parseJsonResponse,
        debounce,
        throttle
    };

    // Also expose commonly used functions directly on window for backward compatibility
    if (!window.escapeHtml) window.escapeHtml = escapeHtml;
    if (!window.formatTime) window.formatTime = formatTime;
    if (!window.debounce) window.debounce = debounce;
    if (!window.throttle) window.throttle = throttle;

})();
