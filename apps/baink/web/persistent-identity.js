/** Explicit opt-in, device-local persistence of a nonextractable signing key.
 * A device session is not a backup. No private key bytes enter localStorage. */
function browserStorage(indexedDB = globalThis.indexedDB) {
  const database = () =>
    new Promise((resolve, reject) => {
      if (!indexedDB)
        return reject(
          Error("Secure device sessions are unavailable in this browser."),
        );
      const r = indexedDB.open("baink-device-session-v1", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("identity");
      r.onerror = () => reject(r.error);
      r.onsuccess = () => resolve(r.result);
    });
  async function operation(mode, fn) {
    const db = await database();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction("identity", mode),
          request = fn(tx.objectStore("identity"));
        let value;
        request.onsuccess = () => {
          value = request.result;
        };
        tx.oncomplete = () => resolve(value);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () =>
          reject(tx.error ?? Error("Device session was not saved."));
      });
    } finally {
      db.close();
    }
  }
  return {
    read: () => operation("readonly", (s) => s.get("current")),
    write: (value) => operation("readwrite", (s) => s.put(value, "current")),
    clear: () => operation("readwrite", (s) => s.delete("current")),
  };
}
// A definite corruption signal: the stored record itself is expired, malformed
// or does not match its own key. Only these delete the kept key. A storage read
// error, a blocked database or a WebCrypto failure is transient and keeps the
// record, because this device key may be the user's only remaining copy.
const corrupt = (message) => Object.assign(Error(message), { deviceSessionCorrupt: true });
export function createIdentitySession({
  storage = browserStorage(),
  now = Date.now,
} = {}) {
  let generation = 0,
    tail = Promise.resolve();
  const serialize = (fn) => {
    const result = tail.then(fn);
    tail = result.catch(() => {});
    return result;
  };
  async function save(identity, { consent = false } = {}) {
    if (!consent) throw Error("Choose to keep this device signed in first.");
    const ticket = ++generation;
    let key = identity.privateKey;
    if (key.extractable) {
      const bytes = await crypto.subtle.exportKey("pkcs8", key);
      try {
        key = await crypto.subtle.importKey("pkcs8", bytes, "Ed25519", false, [
          "sign",
        ]);
      } finally {
        new Uint8Array(bytes).fill(0);
      }
    }
    if (ticket !== generation) return false;
    const record = {
      version: 1,
      privateKey: key,
      publicKey: identity.publicKey,
      publicKeyBase64: identity.publicKeyBase64,
      address: identity.address,
      expiresAt: now() + 7 * 86400000,
    };
    return serialize(async () => {
      if (ticket !== generation) return false;
      await storage.write(record);
      return true;
    });
  }
  async function load() {
    const ticket = generation;
    try {
      await tail;
      const r = await storage.read();
      if (!r) return null;
      if (
        r.version !== 1 ||
        r.expiresAt <= now() ||
        r.expiresAt > now() + 7 * 86400000 ||
        r.privateKey?.extractable !== false ||
        r.privateKey?.type !== "private" ||
        r.publicKey?.type !== "public"
      )
        throw corrupt("Invalid device session");
      const raw = await crypto.subtle.exportKey("raw", r.publicKey);
      const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", raw));
      const address =
        "uain1" +
        Array.from(hash, (b) => b.toString(16).padStart(2, "0"))
          .join("")
          .slice(0, 40);
      const publicKeyBase64 = btoa(String.fromCharCode(...new Uint8Array(raw)));
      if (address !== r.address || publicKeyBase64 !== r.publicKeyBase64)
        throw corrupt("Session identity mismatch");
      const challenge = crypto.getRandomValues(new Uint8Array(32));
      if (
        !(await crypto.subtle.verify(
          "Ed25519",
          r.publicKey,
          await crypto.subtle.sign("Ed25519", r.privateKey, challenge),
          challenge,
        ))
      )
        throw corrupt("Session key mismatch");
      if (ticket !== generation) return null;
      return {
        privateKey: r.privateKey,
        publicKey: r.publicKey,
        publicKeyBase64,
        address,
        persistentSession: true,
      };
    } catch (error) {
      if (error?.deviceSessionCorrupt === true && ticket === generation)
        await serialize(() =>
          ticket === generation ? storage.clear() : undefined,
        ).catch(() => {});
      return null;
    }
  }
  function clear() {
    generation++;
    return serialize(() => storage.clear());
  }
  return { save, load, clear };
}
