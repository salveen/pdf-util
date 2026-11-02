// Lets `node --test` load the TypeScript sources as Vite does. Node strips the types itself;
// this hook resolves extensionless relative imports ("./pdf") to their .ts files.
import { registerHooks } from 'node:module';

registerHooks({
	resolve(specifier, context, nextResolve) {
		try {
			return nextResolve(specifier, context);
		} catch (error) {
			if (!/^\.\.?\//.test(specifier) || /\.[cm]?[jt]s$/.test(specifier)) throw error;
			return nextResolve(`${specifier}.ts`, context);
		}
	}
});
