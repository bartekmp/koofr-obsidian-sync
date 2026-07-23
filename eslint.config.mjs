import js from "@eslint/js";
import globals from "globals";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import obsidianCompat from "./eslint-plugin-obsidian-compat/index.js";

export default [
	{
		ignores: [
			"main.js",
			"**/*.js.map",
			"node_modules/**",
			"coverage/**",
			"*.config.mjs",
			"*.config.js",
			"version-bump.mjs",
		],
	},
	js.configs.recommended,
	{
		files: ["src/**/*.ts"],
		languageOptions: {
			parser: tsParser,
			parserOptions: {
				ecmaVersion: 2020,
				sourceType: "module",
			},
			globals: {
				...globals.node,
				...globals.es2020,
			},
		},
		plugins: {
			"@typescript-eslint": tsPlugin,
			"obsidian-compat": obsidianCompat,
		},
		rules: {
			...tsPlugin.configs["eslint-recommended"].overrides[0].rules,
			...tsPlugin.configs.recommended.rules,
			"no-console": "warn",
			"@typescript-eslint/no-explicit-any": "error",
			"@typescript-eslint/explicit-function-return-type": "off",
			"@typescript-eslint/no-unused-vars": [
				"error",
				{
					argsIgnorePattern: "^_",
					varsIgnorePattern: "^_",
					caughtErrorsIgnorePattern: "^_",
				},
			],
			"obsidian-compat/no-global-document": "warn",
			"obsidian-compat/no-global-this": "warn",
			"obsidian-compat/no-bare-timers": "warn",
			"obsidian-compat/no-static-styles": "warn",
			"obsidian-compat/no-deprecated-display": "warn",
		},
	},
];
