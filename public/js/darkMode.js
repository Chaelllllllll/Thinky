// Dark mode — apply before paint to prevent flash of light content
(function () {
    var STORAGE_KEY = 'theme';
    var dark = localStorage.getItem(STORAGE_KEY) === 'dark';

    function apply(isDark) {
        // Add preload class to suppress transitions during initial apply
        document.body.classList.add('dark-preload');
        document.body.classList.toggle('dark', isDark);
        // Remove preload class next frame so transitions work for user interactions
        requestAnimationFrame(function () {
            requestAnimationFrame(function () {
                document.body.classList.remove('dark-preload');
            });
        });
        updateButtons(isDark);
    }

    function updateButtons(isDark) {
        // Sidebar toggle button
        var icon = document.getElementById('darkModeIcon');
        var label = document.getElementById('darkModeLabel');
        if (icon) icon.className = isDark ? 'bi bi-sun' : 'bi bi-moon-stars';
        if (label) label.textContent = isDark ? 'Light Mode' : 'Dark Mode';

        // Floating button (non-sidebar pages)
        var floatBtn = document.getElementById('darkModeFloatBtn');
        if (floatBtn) floatBtn.innerHTML = isDark
            ? '<i class="bi bi-sun"></i>'
            : '<i class="bi bi-moon-stars"></i>';
    }

    window.toggleDarkMode = function () {
        dark = !dark;
        localStorage.setItem(STORAGE_KEY, dark ? 'dark' : 'light');
        apply(dark);
    };

    // Apply immediately (synchronously, before first paint)
    if (document.body) {
        apply(dark);
    } else {
        // If body isn't ready yet, apply as soon as possible
        document.addEventListener('DOMContentLoaded', function () { apply(dark); }, { once: true });
    }

    // Re-sync buttons once DOM is fully ready (handles scripts that load after)
    document.addEventListener('DOMContentLoaded', function () { updateButtons(dark); });
})();
