import { observeLogin, sanitizeLoginIdentity } from './login-identity.mjs';
import { keepOfficialLoginSession } from './login-session.mjs';
import { installGameNavigation } from './game-navigation.mjs';

const registrations = new WeakMap();

// Preload scripts belong to the CDP session that registered them. A new
// attachment must register again before that session reloads the game page.
export async function registerGamePageHooks(client, gameOrigin) {
  let registration = registrations.get(client);
  if (!registration) {
    registration = (async () => {
      await Promise.all([client.send('Page.enable'), client.send('Runtime.enable')]);
      const source = `
        if (!Object.getOwnPropertyDescriptor(window, '__flowerLoginStatus')) {
          (${observeLogin.toString()})(${JSON.stringify(gameOrigin)}, ${sanitizeLoginIdentity.toString()}, ${keepOfficialLoginSession.toString()});
        }
        (${installGameNavigation.toString()})(${JSON.stringify(gameOrigin)});
      `;
      await client.send('Page.addScriptToEvaluateOnNewDocument', { source });
    })();
    registrations.set(client, registration);
  }
  try {
    await registration;
  } catch (error) {
    if (registrations.get(client) === registration) registrations.delete(client);
    throw error;
  }
}
