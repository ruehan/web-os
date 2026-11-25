// 프로세스 하나의 실행 컨텍스트. 커널이 보낸 WASM 모듈을 돌리고,
// 시스템 콜은 커널에 메시지로 보낸 뒤 공유 메모리에서 응답을 기다린다.
import { armChannel, waitReply, type ProcessInit } from '../kernel/abi.ts'
import { runWasi } from './wasi.ts'

self.onmessage = (e: MessageEvent<ProcessInit>) => {
  const { module, argv, env, channel } = e.data
  runWasi(module, argv, env, {
    call(req) {
      armChannel(channel)
      self.postMessage(req)
      return waitReply(channel)
    },
    send(req) {
      self.postMessage(req)
    },
  })
}
