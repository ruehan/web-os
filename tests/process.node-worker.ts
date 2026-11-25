// 테스트용 프로세스 실행 컨텍스트. 브라우저의 process.worker.ts 와 같은 일을
// Node의 worker_threads 위에서 한다. 실제 스레드라서 블로킹 시스템 콜이 그대로 동작한다.
import { parentPort } from 'node:worker_threads'
import { armChannel, waitReply, type ProcessInit } from '../src/kernel/abi.ts'
import { runWasi } from '../src/process/wasi.ts'

const port = parentPort!
port.once('message', ({ module, argv, env, channel }: ProcessInit) => {
  runWasi(module, argv, env, {
    call(req) {
      armChannel(channel)
      port.postMessage(req)
      return waitReply(channel)
    },
    send: (req) => port.postMessage(req),
  })
})
