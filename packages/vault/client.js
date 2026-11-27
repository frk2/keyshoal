export async function syncDevice(vault, base, request, choice = undefined) {
  // request() is a pinned/authenticated transport, returning only binary bodies and statuses.
  for (let retry = 0; retry < (choice ? 1 : 3); retry++) {
    const remote = await request({ method: 'GET' });
    if (remote.status === 401) throw new Error('This device is no longer authorized. Pair again.');
    if (remote.status !== 200) throw new Error('The desktop vault is unavailable.');
    const revision = vault.revision(remote.body);
    if (choice && choice.revision !== revision) {
      throw new Error('The desktop changed again. Start sync again to review conflicts.');
    }
    const merged = vault.merge(base, remote.body, choice?.resolution);
    if (!merged.bytes) return { revision, conflicts: merged.conflicts };
    if (vault.revision(merged.bytes) === revision) return { bytes: merged.bytes };
    const update = await request({ method: 'PUT', match: revision, body: merged.bytes });
    if (update.status === 204) return { bytes: merged.bytes };
    if (update.status === 401) throw new Error('This device is no longer authorized. Pair again.');
    if (update.status !== 412) throw new Error('The desktop did not accept the encrypted update.');
  }
  throw new Error('The desktop changed during sync. Try again.');
}
