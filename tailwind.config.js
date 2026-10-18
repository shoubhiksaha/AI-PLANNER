/** @type {import('tailwindcss').Config} */
module.exports = {
    content: ["./public/**/*.html", "./public/**/*.js", "!./public/vendor/**", "!./public/__tests__/**"],
    // dark: utilities apply to both the Dark and OLED themes (classes set on <html>)
    darkMode: ['variant', ['&:is(.dark-mode *)', '&:is(.oled-mode *)']],
    theme: {
        extend: {
            colors: {
                theme: {
                    bg: 'var(--bg-main)',
                    card: 'var(--bg-card)',
                    text: 'var(--text-main)',
                    muted: 'var(--text-muted)',
                    border: 'var(--border-color)',
                    glass: 'var(--glass-bg)',
                }
            }
        }
    },
    plugins: [],
}
