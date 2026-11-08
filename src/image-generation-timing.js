import { readFileSync, renameSync, writeFileSync } from 'node:fs';

const categories = ['png', 'reference', 'svg', 'gif'];
const sampleLimit = 30;
const minimumSamples = 5;
const defaultReminderMs = 60_000;

export function createImageGenerationTiming({ file, log = console.warn } = {}) {
  let saved = {};
  if (file) {
    try { saved = JSON.parse(readFileSync(file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') log('image timing history could not be read'); }
  }
  const samples = Object.fromEntries(categories.map(category => {
    const rows = saved?.[category];
    return [category, Array.isArray(rows) ? rows.filter(row =>
      [row?.queueMs, row?.generationMs, row?.deliveryMs].every(ms => Number.isFinite(ms) && ms >= 0)
    ).slice(-sampleLimit) : []];
  }));

  return {
    estimate(category) {
      const rows = samples[category];
      if (rows.length < minimumSamples) return { reminderMs: defaultReminderMs };
      const durations = rows.map(row => row.generationMs + row.deliveryMs).sort((a, b) => a - b);
      const percentile = fraction => Math.ceil(durations[Math.ceil(durations.length * fraction) - 1] / 5000) * 5;
      const low = Math.max(5, percentile(0.5));
      const high = Math.max(low + 5, percentile(0.8));
      return { seconds: `${low}～${high}`, reminderMs: high * 1000 };
    },
    record(category, duration) {
      const rows = samples[category];
      rows.push(duration);
      if (rows.length > sampleLimit) rows.shift();
      if (file) {
        try {
          writeFileSync(file + '.tmp', JSON.stringify(samples), { mode: 0o600 });
          renameSync(file + '.tmp', file);
        } catch { log('image timing history could not be saved'); }
      }
    }
  };
}
