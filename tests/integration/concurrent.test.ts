import { expect, it } from 'vitest'
import { Worker } from 'node:worker_threads'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { MoodStore } from '../../src/host/store.js'

it('four independent Host workers commit 40 simultaneous events without losing state or quota', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mood-concurrency-'))
  const path = join(directory, 'mood.sqlite')
  const initial = new MoodStore(path, { now: () => 1000 }); initial.close()
  const source = `
    import { parentPort, workerData } from 'node:worker_threads';
    import { MoodStore } from ${JSON.stringify(resolve('src/host/store.ts'))};
    const store = new MoodStore(workerData.path, { now: () => 1000 });
    for (let i=0;i<10;i++) {
      const id = workerData.id+':'+i;
      store.addEvidence({id,sessionId:workerData.id,kind:'user',at:1000,text:'独立真实事件'});
      const result=store.applyEmotion({event_id:id,features:[{feature_id:'conflict',direction:'present',intensity:'slight',reason:'冲突',evidence:[id]}]},{sessionId:workerData.id,callId:id});
      if(result.status==='rejected') throw new Error(result.reason);
    }
    store.close(); parentPort.postMessage('done');
  `
  const bundle = await build({ stdin: { contents: source, resolveDir: process.cwd(), sourcefile: 'concurrent-host.ts' }, bundle: true, platform: 'node', format: 'cjs', write: false })
  const workers = Array.from({ length: 4 }, (_, i) => new Worker(bundle.outputFiles[0]!.text, { eval: true, workerData: { id: `worker-${i}`, path } }))
  try {
    await Promise.all(workers.map(worker => new Promise<void>((resolveRun, reject) => { worker.on('error', reject); worker.on('exit', code => code === 0 ? resolveRun() : reject(new Error(`worker exit ${code}`))) })))
    const store = new MoodStore(path, { now: () => 1000 })
    expect(store.snapshot().version).toBe(40)
    expect(store.snapshot().emotions.anger).toBe(40)
    expect(store.history(undefined, 100).items).toHaveLength(40)
    store.close()
  } finally { await Promise.all(workers.map(worker => worker.terminate())); rmSync(directory, { recursive: true, force: true }) }
})
