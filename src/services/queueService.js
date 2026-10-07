import { readDataJson, writeDataJson } from "./googleDrive.js";

const FILE = "queue.json";
const CACHE_MS = 30 * 1000;
let cache = { data: null, at: 0 };

function todayKey() {
    return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

async function loadQueue({ fresh = false } = {}) {
    if (!fresh && cache.data && Date.now() - cache.at < CACHE_MS) return cache.data;
    try {
        const doc = await readDataJson(FILE);
        const data = doc?.data || { days: {} };
        cache = { data, at: Date.now() };
        return data;
    } catch {
        return { days: {} };
    }
}

async function saveQueue(data) {
    await writeDataJson(FILE, data);
    cache = { data, at: Date.now() };
}

/* Generate the next daily token for a normal (non-event) group booking. */
export async function nextDailyToken() {
    const data = await loadQueue({ fresh: true });
    const day = todayKey();
    const current = data.days[day] || 0;
    const next = current + 1;
    data.days[day] = next;

    // Optional cleanup: drop days older than 30 days
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    for (const key of Object.keys(data.days)) {
        if (new Date(key).getTime() < cutoff) delete data.days[key];
    }

    await saveQueue(data);
    return next;
}