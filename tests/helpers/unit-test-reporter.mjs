// Adapt Node's structured runner events to the JSON format consumed by UT results.
export default async function* report(events) {
  const files = new Map();
  const paths = [];
  const records = [];
  for await (const event of events) {
    const data = event.data;
    if (event.type === 'test:dequeue') {
      paths.length = data.nesting;
      paths[data.nesting] = data.name;
    }
    if (event.type !== 'test:pass' && event.type !== 'test:fail') continue;
    const ancestors = paths.slice(0, data.nesting);
    records.push({file: data.file, nesting: data.nesting, name: [...ancestors, data.name].join('/'),
      title: data.name, ancestorTitles: ancestors,
      status: event.type === 'test:pass' ? 'passed' : 'failed',
      failureMessages: event.type === 'test:fail' ? [data.details.error?.cause?.stack ?? data.details.error?.stack ?? String(data.details.error)] : []});
  }
  for (const record of records) {
    if (records.some(child => child.file === record.file && child.nesting > record.nesting && child.name.startsWith(`${record.name}/`))) continue;
    const assertions = files.get(record.file) ?? [];
    assertions.push(record); files.set(record.file, assertions);
  }
  yield JSON.stringify({testResults: [...files].map(([name, assertionResults]) => ({name, assertionResults}))});
}
