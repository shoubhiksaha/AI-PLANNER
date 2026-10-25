/** @type {import('tailwindcss').Config} */
// Colours are ADT design tokens (CSS variables in public/styles.css), so one class works in
// both themes; html.dark-mode switches the variables. `dark:` is rarely needed.
const token = (name) => `var(--${name})`;

module.exports = {
    content: ["./public/**/*.html", "./public/**/*.js", "!./public/vendor/**", "!./public/__tests__/**"],
    darkMode: ['selector', '.dark-mode'],
    theme: {
        extend: {
            colors: {
                bg: token('bg'),
                surface: token('surface'),
                raised: token('raised'),
                line: token('line'),
                'line-strong': token('line-strong'),
                ink: token('ink'),
                muted: token('ink-muted'),
                subtle: token('ink-subtle'),
                signal: token('signal'),
                'signal-hover': token('signal-hover'),
                'on-signal': token('on-signal'),
                'signal-ink': token('signal-ink'),
                'signal-soft': token('signal-soft'),
                success: token('success'),
                'success-soft': token('success-soft'),
                warning: token('warning'),
                'warning-soft': token('warning-soft'),
                danger: token('danger'),
                'danger-soft': token('danger-soft'),
                // Older names kept for markup that hasn't moved to the tokens above
                theme: {
                    bg: token('bg'),
                    card: token('surface'),
                    text: token('ink'),
                    muted: token('ink-muted'),
                    border: token('line'),
                    glass: token('surface'),
                },
            },
            fontFamily: {
                sans: ['"IBM Plex Sans"', '"Helvetica Neue"', 'Arial', 'sans-serif'],
                display: ['"Space Grotesk"', '"Helvetica Neue"', 'Arial', 'sans-serif'],
            },
        },
    },
    plugins: [],
};
