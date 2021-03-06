import {
  FailedMessage,
  SendMessageProps,
  SendReplyMessageProps,
  TransportBase,
  TransportOptions,
  TransportState,
  TransportUtils,
} from '@cheep/transport'
import type { SNS, SQS } from 'aws-sdk'
import { batchDeleteMessages } from './app/batchDeleteMessages'
import { deleteQueue } from './app/deleteQueue'
import { ensureQueueExists } from './app/ensureQueueExists'
import { ensureSubscriptionExists } from './app/ensureSubscriptionExists'
import { ensureTopicExists } from './app/ensureTopicExists'
import { listenQueue } from './app/listenQueue'
import { listenResponseQueue } from './app/listenResponseQueue'
import { processSqsMessages } from './app/processSqsMessages'
import { purgeQueue } from './app/purgeQueue'
import { sendMessageToSns } from './app/sendMessageToSns'
import { sendMessageToSqs } from './app/sendMessageToSqs'

export class SnsSqsTransport extends TransportBase {
  private topicArn: string
  private queueArn: string
  private queueUrl: string
  private deadLetterQueueArn: string
  private deadLetterQueueUrl: string
  private responseQueueUrl: string

  constructor(
    protected options: TransportOptions & {
      config:
        | {
            type: 'AUTO'
            moduleName: string
            publishTopicName: string
          }
        | {
            type: 'MANUAL'
            topicArn: string
            queueArn: string
            queueUrl: string
            deadLetterQueueArn: string
            deadLetterQueueUrl: string
          }

      keepExistingSubscriptionFilters?: boolean
      purgeQueuesOnStart?: boolean

      queueWaitTimeInSeconds?: number
      queueMaxNumberOfMessages?: number

      responseQueueWaitTimeInSeconds?: number
      responseQueueMaxNumberOfMessages?: number
    },
    protected utils: TransportUtils & {
      getMessageGroup: (route: string) => string
      getSns: () => SNS
      getSqs: () => SQS
    },
  ) {
    super(options, utils)
  }

  async init() {
    const { config } = this.options

    switch (config.type) {
      case 'AUTO':
        {
          const { moduleName, publishTopicName } = config

          const rpcResponseQueueName = `${moduleName}-response-${this.utils.newId()}`

          this.topicArn = await ensureTopicExists({
            sns: this.utils.getSns(),
            publishTopicName,
            tagName: moduleName,
          })

          const deadLetterQueue = await ensureQueueExists({
            sqs: this.utils.getSqs(),
            queueName: `${moduleName}-dl`,
            deadLetterQueueArn: null,
            tagName: moduleName,
            isFifo: true,
          })

          const queue = await ensureQueueExists({
            sqs: this.utils.getSqs(),
            queueName: moduleName,
            deadLetterQueueArn: deadLetterQueue.queueArn,
            tagName: moduleName,
            isFifo: true,
          })

          const responseQueue = await ensureQueueExists({
            sqs: this.utils.getSqs(),
            queueName: rpcResponseQueueName,
            deadLetterQueueArn: null,
            tagName: moduleName,
            isFifo: false,
          })

          this.queueArn = queue.queueArn
          this.queueUrl = queue.queueUrl
          this.responseQueueUrl = responseQueue.queueUrl
          this.deadLetterQueueArn = deadLetterQueue.queueArn
          this.deadLetterQueueUrl = deadLetterQueue.queueUrl
        }
        break

      case 'MANUAL':
        {
          const rpcResponseQueueName = `response-${this.utils.newId()}`

          const responseQueue = await ensureQueueExists({
            sqs: this.utils.getSqs(),
            queueName: rpcResponseQueueName,
            deadLetterQueueArn: null,
            tagName: null,
            isFifo: false,
          })

          this.topicArn = config.topicArn
          this.queueArn = config.queueArn
          this.queueUrl = config.queueUrl
          this.responseQueueUrl = responseQueue.queueUrl
          this.deadLetterQueueArn = config.queueArn
          this.deadLetterQueueUrl = config.queueUrl
        }
        break
    }
  }

  async start() {
    await super.start()

    if (this.options.purgeQueuesOnStart) {
      await purgeQueue({
        sqs: this.utils.getSqs(),
        queueUrl: this.queueUrl,
      })

      await purgeQueue({
        sqs: this.utils.getSqs(),
        queueUrl: this.deadLetterQueueUrl,
      })
    }

    const routes = this.getRegisteredRoutes()
    const prefixes = this.getRegisteredPrefixes()

    await ensureSubscriptionExists({
      sns: this.utils.getSns(),
      topicArn: this.topicArn,
      queueArn: this.queueArn,
      deadLetterArn: this.deadLetterQueueArn,
      routes,
      prefixes,
      keepExistingSubscriptionFilters:
        this.options.keepExistingSubscriptionFilters ?? false,
    })

    // listen messages
    listenQueue({
      sqs: this.utils.getSqs(),
      queueUrl: this.queueUrl,
      isSnsMessage: true,
      maxNumberOfMessages: this.options.queueMaxNumberOfMessages,
      waitTimeInSeconds: this.options.queueWaitTimeInSeconds,
      newId: () => this.utils.newId(),
      requestAttemptId: this.utils.newId(),
      shouldContinue: () => this.state === TransportState.STARTED,
      cb: items =>
        processSqsMessages(
          this.queueUrl,
          this.deadLetterQueueUrl,
          items,
          this.utils.getSqs,
          x => this.processMessage(x),
        ),
    })
  }

  async dispose() {
    await super.dispose()

    await deleteQueue({
      sqs: this.utils.getSqs(),
      queueUrl: this.responseQueueUrl,
    })
  }

  async subscribeFailedMessages(
    action: (failedMessage: FailedMessage) => Promise<void> | void,
  ) {
    throw Error(
      'SnsSqs Transport: subscribeFailedMessages not implemented',
    )
  }

  protected async sendMessage(props: SendMessageProps) {
    const { route, message, correlationId, isRpc } = props

    const sns = this.utils.getSns()

    await sendMessageToSns({
      sns,
      topicArn: this.topicArn,
      route,
      message,
      deduplicationId: this.utils.newId(),
      messageGroupId: this.utils.getMessageGroup(route),

      ...(isRpc
        ? {
            replyToQueueUrl: this.responseQueueUrl,
            correlationId,
          }
        : null),
    })
  }

  protected async sendReplyMessage(
    props: SendReplyMessageProps,
  ): Promise<void> {
    const { replyTo: queueUrl, correlationId, message } = props

    const sqs = this.utils.getSqs()

    await sendMessageToSqs({
      sqs,
      queueUrl,
      correlationId,
      message,
    })
  }

  protected newRpcCallRegistered(activeCount: number) {
    if (activeCount === 1) {
      let pendingItemsCount = activeCount

      listenResponseQueue({
        sqs: this.utils.getSqs(),
        responseQueueUrl: this.responseQueueUrl,
        newId: this.utils.newId,
        shouldContinue: () => pendingItemsCount > 0,
        cb: items => {
          // acknowledgement async way
          if (items.length) {
            batchDeleteMessages({
              sqs: this.utils.getSqs(),
              queueUrl: this.responseQueueUrl,
              receiptHandles: items.map(x => x.receiptHandle),
            }).catch(console.warn)
          }

          // process
          for (const item of items) {
            try {
              pendingItemsCount = this.processResponseMessage(item)
            } catch (err) {
              console.warn(err)
            }
          }
        },
      })
    }
  }
}
