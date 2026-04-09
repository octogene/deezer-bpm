import globals from 'globals';

export default [
    {
        files: [
            "content/constants.js",
            "content/utils.js",
            "content/cache.js",
            "content/api.js",
            "content/resolver.js",
            "content/badge.js",
            "content/playlist.js",
            "content/observers.js",
            "content/main.js"
        ],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'script', // content.js is an IIFE, not a module
            globals: {
                ...globals.browser,
                chrome: 'readonly',
                browser: 'readonly',
            },
        },
        rules: {
            'no-unused-vars': 'warn',
            'no-undef': 'error',
            'no-console': 'off',
            'eqeqeq': ['error', 'always'],
            'no-var': 'error',
            'prefer-const': 'warn',
        },
    },
    {
        files: ['web-ext-config.mjs'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: globals.node,
        },
    },
];