import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    { ignores: ['dist/', 'extension/dist/', 'test-output/'] },
    {
        extends: [eslint.configs.recommended, ...tseslint.configs.recommended],
        rules: {
            curly: ['error', 'all'],

            // 允许 while (true) 等有意为之的无限循环
            'no-constant-condition': ['warn', { checkLoops: false }],

            // 未使用变量：允许 _ 前缀的参数
            '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],

            // 类成员排序
            '@typescript-eslint/member-ordering': [
                'warn',
                {
                    default: [
                        'public-static-field',
                        'protected-static-field',
                        'private-static-field',
                        'public-field',
                        'protected-field',
                        'private-field',
                        'constructor',
                        'public-static-method',
                        'protected-static-method',
                        'private-static-method',
                        'public-method',
                        'protected-method',
                        'private-method',
                    ],
                },
            ],
        },
    },
    {
        files: ['src/**/*.ts', 'extension/src/**/*.ts'],
        languageOptions: {
            parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
        },
        rules: {
            '@typescript-eslint/no-floating-promises': 'error',
            '@typescript-eslint/return-await': ['error', 'error-handling-correctness-only'],
        },
    },
    {
        files: ['test/**/*.{js,mjs}', 'extension/test/**/*.{js,mjs}'],
        languageOptions: {
            globals: {
                AbortController: 'readonly',
                AbortSignal: 'readonly',
                clearTimeout: 'readonly',
                clearImmediate: 'readonly',
                Buffer: 'readonly',
                console: 'readonly',
                process: 'readonly',
                setImmediate: 'readonly',
                setTimeout: 'readonly',
                URL: 'readonly',
                WeakRef: 'readonly',
            },
        },
    }
);
