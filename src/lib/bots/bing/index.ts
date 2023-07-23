import { fetch, WebSocket, debug } from '@/lib/isomorphic'
import WebSocketAsPromised from 'websocket-as-promised'
import {
  SendMessageParams,
  BingConversationStyle,
  ConversationResponse,
  ChatResponseMessage,
  ConversationInfo,
  InvocationEventType,
  ChatError,
  ErrorCode,
  ChatUpdateCompleteResponse
} from './types'

import { convertMessageToMarkdown, websocketUtils, streamAsyncIterable, createImage } from './utils'
import { createChunkDecoder } from '@/lib/utils'

type Params = SendMessageParams<{ bingConversationStyle: BingConversationStyle, useProxy: boolean }>

const OPTIONS_SETS = [
  'nlu_direct_response_filter',
  'deepleo',
  'disable_emoji_spoken_text',
  'responsible_ai_policy_235',
  'enablemm',
  'iycapbing',
  'iyxapbing',
  'objopinion',
  'rweasgv2',
  'dagslnv1',
  'dv3sugg',
  'autosave',
  'iyoloxap',
  'iyoloneutral',
  'clgalileo',
  'gencontentv3',
]

export class BingWebBot {
  protected conversationContext?: ConversationInfo
  protected cookie: string
  protected ua: string
  protected endpoint = ''
  private lastText = ''
  private asyncTasks: Array<Promise<any>> = []

  constructor(opts: {
    cookie: string
    ua: string
    bingConversationStyle?: BingConversationStyle
    conversationContext?: ConversationInfo
  }) {
    const { cookie, ua, conversationContext } = opts
    this.cookie = cookie?.includes(';') ? cookie : `_EDGE_V=1; _U=${cookie}`
    this.ua = ua
    this.conversationContext = conversationContext
  }

  static buildChatRequest(conversation: ConversationInfo) {
    const optionsSets = OPTIONS_SETS
    if (conversation.conversationStyle === BingConversationStyle.Precise) {
      optionsSets.push('h3precise')
    } else if (conversation.conversationStyle === BingConversationStyle.Creative) {
      optionsSets.push('h3imaginative')
    }
    return {
      arguments: [
        {
          source: 'cib',
          optionsSets,
          allowedMessageTypes: [
            'Chat',
            'InternalSearchQuery',
            'Disengaged',
            'InternalLoaderMessage',
            'SemanticSerp',
            'GenerateContentQuery',
            'SearchQuery',
          ],
          sliceIds: [
            'winmuid1tf',
            'anssupfor_c',
            'imgchatgptv2',
            'tts2cf',
            'contansperf',
            'mlchatpc8500w',
            'mlchatpc2',
            'ctrlworkpay',
            'winshortmsgtf',
            'cibctrl',
            'sydtransctrl',
            'sydconfigoptc',
            '0705trt4',
            '517opinion',
            '628ajcopus0',
            '330uaugs0',
            '529rwea',
            '0626snptrcs0',
            '424dagslnv1',
          ],
          isStartOfSession: conversation.invocationId === 0,
          message: {
            author: 'user',
            inputMethod: 'Keyboard',
            text: conversation.prompt,
            messageType: 'Chat',
          },
          conversationId: conversation.conversationId,
          conversationSignature: conversation.conversationSignature,
          participant: { id: conversation.clientId },
        },
      ],
      invocationId: conversation.invocationId.toString(),
      target: 'chat',
      type: InvocationEventType.StreamInvocation,
    }
  }

  async createConversation(): Promise<ConversationResponse> {
    const headers = {
      'Accept-Encoding': 'gzip, deflate, br, zsdch',
      'User-Agent': this.ua,
      'x-ms-useragent': 'azsdk-js-api-client-factory/1.0.0-beta.1 core-rest-pipeline/1.10.0 OS/Win32',
      cookie: this.cookie,
    }

    let resp: ConversationResponse | undefined
    try {
      const response = await fetch(this.endpoint + '/api/create', { method: 'POST', headers, redirect: 'error', mode: 'cors', credentials: 'include' })
      if (response.status === 404) {
        throw new ChatError('Not Found', ErrorCode.NOTFOUND_ERROR)
      }
      resp = await response.json() as ConversationResponse
    } catch (err) {
      console.error('retry bing create', err)
      // await sleep(60000)
      // return this.createConversation()
    }

    if (!resp?.result) {
      throw new ChatError('Invalid response', ErrorCode.UNKOWN_ERROR)
    }

    const { value, message } = resp.result || {}
    if (value !== 'Success') {
      const errorMsg = `${value}: ${message}`
      if (value === 'UnauthorizedRequest') {
        throw new ChatError(errorMsg, ErrorCode.BING_UNAUTHORIZED)
      }
      if (value === 'Forbidden') {
        throw new ChatError(errorMsg, ErrorCode.BING_FORBIDDEN)
      }
      if (value === 'Cookie') {
        throw new ChatError(errorMsg, ErrorCode.COOKIE_ERROR)
      }
      throw new ChatError(errorMsg, ErrorCode.UNKOWN_ERROR)
    }
    return resp
  }

  async sendMessage(params: Params) {
    try {
      if (!this.conversationContext) {
        const conversation = await this.createConversation()
        this.conversationContext = {
          conversationId: conversation.conversationId,
          conversationSignature: conversation.conversationSignature,
          clientId: conversation.clientId,
          invocationId: 0,
          conversationStyle: params.options.bingConversationStyle,
          prompt: ''
        }
      }
      Object.assign(this.conversationContext, { prompt: params.prompt })

      if (params.options.useProxy) {
        return this.useProxy(params)
      }
      return this.useWs(params)
    } catch (error) {
      params.onEvent({
        type: 'ERROR',
        error: error instanceof ChatError ? error : new ChatError('Catch Error', ErrorCode.UNKOWN_ERROR),
      })
    }
  }

  private async useProxy(params: Params) {
    const abortController = new AbortController()
    const response = await fetch(this.endpoint + '/api/sydney', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      signal: abortController.signal,
      body: JSON.stringify(this.conversationContext!)
    })
    if (response.status !== 200) {
      params.onEvent({
        type: 'ERROR',
        error: new ChatError(
          'Unknown error',
          ErrorCode.UNKOWN_ERROR,
        ),
      })
    }
    params.signal?.addEventListener('abort', () => {
      abortController.abort()
    })

    const textDecoder = createChunkDecoder()
    for await (const chunk of streamAsyncIterable(response.body!)) {
      this.parseEvents(params, websocketUtils.unpackMessage(textDecoder(chunk)))
    }
  }

  async sendWs() {
    const wsConfig: ConstructorParameters<typeof WebSocketAsPromised>[1] =  {
      packMessage: websocketUtils.packMessage,
      unpackMessage: websocketUtils.unpackMessage,
      createWebSocket: (url) => new WebSocket(url, {
        headers: {
          'accept-language': 'zh-CN,zh;q=0.9',
          'cache-control': 'no-cache',
          'User-Agent': this.ua,
          pragma: 'no-cache',
          cookie: this.cookie,
        }
      })
    }
    const wsp = new WebSocketAsPromised('wss://sydney.bing.com/sydney/ChatHub', wsConfig)

    wsp.open().then(() => {
      wsp.sendPacked({ protocol: 'json', version: 1 })
      wsp.sendPacked({ type: 6 })
      wsp.sendPacked(BingWebBot.buildChatRequest(this.conversationContext!))
    })

    return wsp
  }

  private async useWs (params: Params) {
    const wsp = await this.sendWs()

    wsp.onUnpackedMessage.addListener((events) => {
      if (Math.ceil(Date.now() / 1000) % 3 === 0) {
        wsp.sendPacked({ type: 6 })
      }
      this.parseEvents(params, events)
    })

    wsp.onClose.addListener(() => {
      params.onEvent({ type: 'DONE' })
      wsp.removeAllListeners()
    })

    params.signal?.addEventListener('abort', () => {
      wsp.removeAllListeners()
      wsp.close()
    })
  }

  private async createImage(prompt: string, id: string) {
    try {
      const headers = {
        'Accept-Encoding': 'gzip, deflate, br, zsdch',
        'User-Agent': this.ua,
        'x-ms-useragent': 'azsdk-js-api-client-factory/1.0.0-beta.1 core-rest-pipeline/1.10.0 OS/Win32',
        cookie: this.cookie,
      }
      const query = new URLSearchParams({
        prompt,
        id
      })
      const response = await fetch(this.endpoint + '/api/image?' + query.toString(), { method: 'POST', headers, redirect: 'error', mode: 'cors', credentials: 'include' })
        .then(res => res.text())
        if (response) {
          this.lastText += '\n' + response
        }
    } catch (err) {
      console.error('Create Image Error', err)
    }
  }

  private async generateContent(message: ChatResponseMessage) {
    if (message.contentType === 'IMAGE') {
      this.asyncTasks.push(this.createImage(message.text, message.messageId))
    }
  }

  private async parseEvents(params: Params, events: any) {
    const conversation = this.conversationContext!

    for (const event of events as ChatUpdateCompleteResponse[]) {
      debug('bing ws event', event)
      if (event.type === 3) {
        await Promise.all(this.asyncTasks)
        params.onEvent({ type: 'UPDATE_ANSWER', data: { text: this.lastText } })
        params.onEvent({ type: 'DONE' })
        conversation.invocationId = parseInt(event.invocationId, 10) + 1
      } else if (event.type === 1) {
        const messages = event.arguments[0].messages
        if (messages) {
          const text = convertMessageToMarkdown(messages[0])
          this.lastText = text
          params.onEvent({ type: 'UPDATE_ANSWER', data: { text, throttling: event.arguments[0].throttling } })
        }
      } else if (event.type === 2) {
        const messages = event.item.messages as ChatResponseMessage[] | undefined
        if (!messages) {
          params.onEvent({
            type: 'ERROR',
            error: new ChatError(
              event.item.result.error || 'Unknown error',
              event.item.result.value === 'CaptchaChallenge' ? ErrorCode.BING_CAPTCHA : ErrorCode.UNKOWN_ERROR,
            ),
          })
          return
        }
        const limited = messages.some((message) =>
          message.contentOrigin === 'TurnLimiter'
          || message.messageType === 'Disengaged'
        )
        if (limited) {
          params.onEvent({
            type: 'ERROR',
            error: new ChatError(
              'Sorry, you have reached chat limit in this conversation.',
              ErrorCode.CONVERSATION_LIMIT,
            ),
          })
          return
        }

        const lastMessage = event.item.messages.at(-1) as ChatResponseMessage
        if (lastMessage?.messageType) {
          return this.generateContent(lastMessage)
        }

        if (lastMessage) {
          const text = convertMessageToMarkdown(lastMessage)
          this.lastText = text
          params.onEvent({
            type: 'UPDATE_ANSWER',
            data: { text, throttling: event.item.throttling, suggestedResponses: lastMessage.suggestedResponses, sourceAttributions: lastMessage.sourceAttributions },
          })
        }
      }
    }
  }

  resetConversation() {
    this.conversationContext = undefined
  }
}
