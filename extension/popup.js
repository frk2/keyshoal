import { fillExactOrigin } from './fill.js';

const status = document.getElementById('status');
const entries = document.getElementById('entries');
function message(text) { status.textContent = text; }
async function native(request) {
  let response;
  try { response = await chrome.runtime.sendNativeMessage('com.keyshoal.desktop', request); }
  catch { throw new Error('Cannot reach Keyshoal. Check the native host installation and open the desktop app.'); }
  if (!response || response.error) throw new Error(response?.error ?? 'Keyshoal did not respond.');
  return response;
}

async function start() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = new URL(tab?.url ?? 'about:blank');
  if (url.protocol !== 'https:') return message('Visit the HTTPS website where you want to fill a login.');
  const [page] = await chrome.scripting.executeScript({
    target: { tabId: tab.id, frameIds: [0] },
    func: () => location.origin
  });
  if (!page?.documentId || page.result !== url.origin) return message('The tab changed. Reopen Keyshoal.');
  const origin = url.origin;
  document.getElementById('site').textContent = origin;
  const { entries: logins } = await native({ action: 'list', origin });
  message(logins.length ? 'Choose a login to fill.' : 'No saved login for this exact website.');
  for (const { id, title } of logins) {
    const button = document.createElement('button');
    button.textContent = title;
    entries.append(button);
    button.addEventListener('click', async () => {
      for (const item of entries.children) item.disabled = true;
      try {
        const [current] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (current?.id !== tab.id || new URL(current.url).origin !== origin) throw new Error('The tab changed. Reopen Keyshoal.');
        const response = await native({ action: 'fill', origin, id });
        try {
          const [result] = await chrome.scripting.executeScript({
            target: { tabId: tab.id, documentIds: [page.documentId] },
            func: fillExactOrigin,
            args: [origin, response]
          });
          if (!result?.result) throw new Error('No unambiguous sign-in form was found. Nothing was filled.');
          message('Filled. Review the form before submitting.');
          entries.replaceChildren();
        } finally { response.username = response.password = ''; }
      } catch (error) {
        message(error.message);
        for (const item of entries.children) item.disabled = false;
      }
    });
  }
}
start().catch(error => message(error.message));
