import { randomBytes } from 'crypto'
import { WebSocket } from 'ws'
import axios from 'axios'
import { config } from 'process'

export const FORMAT_CONTENT_TYPE = new Map([
  ['raw-16khz-16bit-mono-pcm', 'audio/basic'],
  ['raw-48khz-16bit-mono-pcm', 'audio/basic'],
  ['raw-8khz-8bit-mono-mulaw', 'audio/basic'],
  ['raw-8khz-8bit-mono-alaw', 'audio/basic'],

  ['raw-16khz-16bit-mono-truesilk', 'audio/SILK'],
  ['raw-24khz-16bit-mono-truesilk', 'audio/SILK'],

  ['riff-16khz-16bit-mono-pcm', 'audio/x-wav'],
  ['riff-24khz-16bit-mono-pcm', 'audio/x-wav'],
  ['riff-48khz-16bit-mono-pcm', 'audio/x-wav'],
  ['riff-8khz-8bit-mono-mulaw', 'audio/x-wav'],
  ['riff-8khz-8bit-mono-alaw', 'audio/x-wav'],

  ['audio-16khz-32kbitrate-mono-mp3', 'audio/mpeg'],
  ['audio-16khz-64kbitrate-mono-mp3', 'audio/mpeg'],
  ['audio-16khz-128kbitrate-mono-mp3', 'audio/mpeg'],
  ['audio-24khz-48kbitrate-mono-mp3', 'audio/mpeg'],
  ['audio-24khz-96kbitrate-mono-mp3', 'audio/mpeg'],
  ['audio-24khz-160kbitrate-mono-mp3', 'audio/mpeg'],
  ['audio-48khz-96kbitrate-mono-mp3', 'audio/mpeg'],
  ['audio-48khz-192kbitrate-mono-mp3', 'audio/mpeg'],

  ['webm-16khz-16bit-mono-opus', 'audio/webm; codec=opus'],
  ['webm-24khz-16bit-mono-opus', 'audio/webm; codec=opus'],

  ['ogg-16khz-16bit-mono-opus', 'audio/ogg; codecs=opus; rate=16000'],
  ['ogg-24khz-16bit-mono-opus', 'audio/ogg; codecs=opus; rate=24000'],
  ['ogg-48khz-16bit-mono-opus', 'audio/ogg; codecs=opus; rate=48000'],
])

interface PromiseExecutor {
  resolve: (value?: any) => void
  reject: (reason?: any) => void
}

export class Service {
  private ws: WebSocket | null = null

  private executorMap: Map<string, PromiseExecutor>
  private bufferMap: Map<string, Buffer>

  private heartbeatTimer: NodeJS.Timer | null = null
  private _token = null
  constructor() {
    this.executorMap = new Map()
    this.bufferMap = new Map()
  }

  private async refreshToken() {
    let response = await axios.get(
      'https://azure.microsoft.com/zh-cn/services/cognitive-services/text-to-speech/',
    )
    let data = response.data
    let matches = data.match(/token:\s\"(?<token>.*)\"/)
    this._token = matches.groups.token
    console.log('?????????????????????', this._token)
  }

  public async getToken() {
    try {
      if (this._token == null) {
        await this.refreshToken()
      } else {
        await axios.get(
          'https://westus.tts.speech.microsoft.com/cognitiveservices/voices/list',
          {
            headers: {
              authorization: `Bearer ${this._token}`,
            },
          },
        )
      }
    } catch (error) {
      if (error.response.status == 401) {
        console.log('????????????????????????')
        await this.refreshToken()
      }
    }
    return this._token
  }

  private async sendHeartbeat() {
    if (this.ws && this.ws.readyState == WebSocket.OPEN) {
      const requestId = randomBytes(16).toString('hex').toLowerCase()
      console.debug(`???????????????${requestId}`)
      let ssml =
        '<speak xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="http://www.w3.org/2001/mstts" xmlns:emo="http://www.w3.org/2009/10/emotionml" version="1.0" xml:lang="en-US"><voice name="en-US-JennyNeural"><prosody rate="0%" pitch="0%">??????</prosody></voice></speak>'
      let ssmlMessage =
        `X-Timestamp:${Date()}\r\n` +
        `X-RequestId:${requestId}\r\n` +
        `Content-Type:application/ssml+xml\r\n` +
        `Path:ssml\r\n\r\n` +
        ssml
      await this.ws.ping()
      await this.ws.send(ssmlMessage, (ssmlError) => {})
    }
  }

  private async connect(): Promise<WebSocket> {
    let token = await this.getToken()
    const connectionId = randomBytes(16).toString('hex').toUpperCase()
    let url = `wss://eastus.tts.speech.microsoft.com/cognitiveservices/websocket/v1?Authorization=bearer ${token}&X-ConnectionId=301148E0CF8E416D995BCF6E886A1F61${connectionId}`
    let ws = new WebSocket(url, {
      host: 'eastus.tts.speech.microsoft.com',
      origin: 'https://azure.microsoft.com',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/103.0.5060.66 Safari/537.36 Edg/103.0.1264.44',
      },
    })
    return new Promise((resolve, reject) => {
      ws.on('open', () => {
        resolve(ws)
      })
      ws.on('close', (code, reason) => {
        // ???????????????????????????????????????
        this.ws = null
        if (this.heartbeatTimer) {
          clearTimeout(this.heartbeatTimer)
          this.heartbeatTimer = null
        }
        for (let [key, value] of this.executorMap) {
          value.reject(`???????????????: ${reason} ${code}`)
        }
        this.executorMap.clear()
        this.bufferMap.clear()
        console.info(`?????????????????? ${reason} ${code}`)
      })

      ws.on('message', (message, isBinary) => {
        let pattern = /X-RequestId:(?<id>[a-z|0-9]*)/
        if (!isBinary) {
          console.debug('?????????????????????%s', message)
          let data = message.toString()
          if (data.includes('Path:turn.start')) {
            // ????????????
            let matches = data.match(pattern)
            let requestId = matches.groups.id
            console.debug(`???????????????${requestId}??????`)
            this.bufferMap.set(requestId, Buffer.from([]))
          } else if (data.includes('Path:turn.end')) {
            // ????????????
            let matches = data.match(pattern)
            let requestId = matches.groups.id

            let executor = this.executorMap.get(requestId)
            if (executor) {
              this.executorMap.delete(matches.groups.id)
              let result = this.bufferMap.get(requestId)
              executor.resolve(result)
            }
            console.debug(`???????????????${requestId}`)
          }
        } else if (isBinary) {
          let separator = 'Path:audio\r\n'
          let data = message as Buffer
          let contentIndex = data.indexOf(separator) + separator.length

          let headers = data.slice(2, contentIndex).toString()
          let matches = headers.match(pattern)
          let requestId = matches.groups.id

          let content = data.slice(contentIndex)

          console.debug(
            `?????????????????????${requestId} Length: ${content.length}\n${headers}`,
          )
          let buffer = this.bufferMap.get(requestId)
          if (buffer) {
            buffer = Buffer.concat([buffer, content])
            this.bufferMap.set(requestId, buffer)
            console.debug(`???????????????${requestId}`)
          } else {
            console.debug(`???????????????${requestId}`)
          }
        }
      })
      ws.on('error', (error) => {
        console.log(error)
        console.error(`??????????????? ${error}`)
        reject(`??????????????? ${error}`)
      })
      ws.on('ping', (data) => {
        console.debug('received ping %s', data)
        ws.pong(data)
        console.debug('sent pong %s', data)
      })
      ws.on('pong', (data) => {
        console.debug('received pong %s', data)
      })
    })
  }

  public async convert(ssml: string, format: string) {
    if (this.ws == null || this.ws.readyState != WebSocket.OPEN) {
      console.info('???????????????????????????')
      let connection = await this.connect()
      this.ws = connection
      console.info('???????????????')
    }
    const requestId = randomBytes(16).toString('hex').toLowerCase()
    let result = new Promise((resolve, reject) => {
      // ??????????????????????????????????????????????????????
      this.executorMap.set(requestId, {
        resolve,
        reject,
      })
      // ??????????????????
      let configData = {
        context: {
          synthesis: {
            audio: {
              metadataoptions: {
                sentenceBoundaryEnabled: 'false',
                wordBoundaryEnabled: 'false',
              },
              outputFormat: format,
            },
          },
        },
      }
      let configMessage =
        `X-Timestamp:${Date()}\r\n` +
        'Content-Type:application/json; charset=utf-8\r\n' +
        'Path:speech.config\r\n\r\n' +
        JSON.stringify(configData)
      console.info(`???????????????${requestId}??????`)
      console.debug(`???????????????????????????${requestId}\n`, configMessage)
      this.ws.send(configMessage, (configError) => {
        if (configError) {
          console.error(`???????????????????????????${requestId}\n`, configError)
        }

        // ??????SSML??????
        let ssmlMessage =
          `X-Timestamp:${Date()}\r\n` +
          `X-RequestId:${requestId}\r\n` +
          `Content-Type:application/ssml+xml\r\n` +
          `Path:ssml\r\n\r\n` +
          ssml
        console.debug(`????????????SSML?????????${requestId}\n`, ssmlMessage)
        this.ws.send(ssmlMessage, (ssmlError) => {
          if (ssmlError) {
            console.error(`SSML?????????????????????${requestId}\n`, ssmlError)
          }
        })
      })
    })

    // ????????????????????????????????????
    if (this.heartbeatTimer) {
      console.debug('??????????????????????????????????????????')
      clearTimeout(this.heartbeatTimer)
    }
    // ????????????????????????10????????????????????????????????????????????????????????????
    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeat()
    }, 10000)

    let data = await Promise.race([
      result,
      new Promise((resolve, reject) => {
        // ???????????? 60 ??????????????????????????????????????????????????????
        setTimeout(() => {
          this.executorMap.delete(requestId)
          this.bufferMap.delete(requestId)
          reject('????????????')
        }, 60000)
      }),
    ])
    console.info(`???????????????${requestId}`)
    console.info(`?????? ${this.executorMap.size} ?????????`)
    return data
  }
}

export const service = new Service()
