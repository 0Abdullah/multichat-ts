import js from '@eslint/js'
import prettier from 'eslint-config-prettier'
import ts from 'typescript-eslint'

export default [
	js.configs.recommended,
	...ts.configs.recommended,
	prettier,
	{
		ignores: ['dist/'],
	}
]
