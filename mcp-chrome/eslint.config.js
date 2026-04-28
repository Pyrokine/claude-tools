import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config({
    extends: [eslint.configs.recommended, ...tseslint.configs.recommended],
    ignores: ['**/*.css', '**/*.json', 'dist/', 'extension/dist/'],
    rules: {
        // 空行控制
        'no-multiple-empty-lines': ['warn', { max: 1, maxEOF: 0, maxBOF: 0 }],
        'lines-between-class-members': ['warn', 'always', { exceptAfterSingleLine: true }],
        'padding-line-between-statements': [
            'warn',
            { blankLine: 'always', prev: 'import', next: '*' },
            { blankLine: 'any', prev: 'import', next: 'import' },
        ],

        // 关键字/运算符间距
        'keyword-spacing': ['warn', { before: true, after: true }],
        'space-infix-ops': 'warn',
        'space-before-blocks': 'warn',

        // else/catch/finally 与大括号同行
        'brace-style': ['warn', '1tbs', { allowSingleLine: false }],

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
});
