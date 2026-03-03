/** @type {import('tailwindcss').Config} */
module.exports = {
    content: ["./public/**/*.html"],
    darkMode: 'class',
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
