import js from "@eslint/js";

export default [
    js.configs.recommended,
    {
        files: ["**/*.js", "**/*.jsx"],
        languageOptions: {
            ecmaVersion: "latest",
            sourceType: "module",
            parserOptions: {
                ecmaFeatures: {
                    jsx: true
                }
            },
            globals: {
                console: "readonly",
                setTimeout: "readonly",
                clearTimeout: "readonly",
                setInterval: "readonly",
                clearInterval: "readonly",
                require: "readonly",
                module: "readonly",
                __dirname: "readonly",
                process: "readonly",
                fetch: "readonly",
                window: "readonly",
                document: "readonly",
                navigator: "readonly",
                URL: "readonly"
            }
        },
        rules: {
            "no-unused-vars": "warn",
            "no-undef": "error",
            "no-empty": "off"
        }
    }
];
