import {
  type Message,
  createDataStreamResponse,
  smoothStream,
  streamText,
} from 'ai';
import OpenAI from 'openai'; // 引入OpenAI SDK（火山引擎兼容）

import { auth } from '@/app/(auth)/auth';
import { myProvider } from '@/lib/ai/models';
import { systemPrompt } from '@/lib/ai/prompts';
import {
  deleteChatById,
  getChatById,
  saveChat,
  saveMessages,
} from '@/lib/db/queries';
import {
  generateUUID,
  getMostRecentUserMessage,
  sanitizeResponseMessages,
} from '@/lib/utils';

import { generateTitleFromUserMessage } from '../../actions';
import { createDocument } from '@/lib/ai/tools/create-document';
import { updateDocument } from '@/lib/ai/tools/update-document';
import { requestSuggestions } from '@/lib/ai/tools/request-suggestions';
import { getWeather } from '@/lib/ai/tools/get-weather';

// 初始化火山引擎客户端（核心修改点）
const volcClient = new OpenAI({
  apiKey: process.env.ARK_API_KEY!, // 确保环境变量名称一致
  baseURL: 'https://ark.cn-beijing.volces.com/api/v3', // 火山API端点
  defaultHeaders: {
    'X-Volc-Host': 'ark.cn-beijing.volces.com' // 必要认证头
  }
});

export const maxDuration = 60;

export async function POST(request: Request) {
  const {
    id,
    messages,
    selectedChatModel,
  }: { id: string; messages: Array<Message>; selectedChatModel: string } =
    await request.json();

  const session = await auth();

  if (!session || !session.user || !session.user.id) {
    return new Response('Unauthorized', { status: 401 });
  }

  const userMessage = getMostRecentUserMessage(messages);

  if (!userMessage) {
    return new Response('No user message found', { status: 400 });
  }

  const chat = await getChatById({ id });

  if (!chat) {
    const title = await generateTitleFromUserMessage({ message: userMessage });
    await saveChat({ id, userId: session.user.id, title });
  }

  await saveMessages({
    messages: [{ ...userMessage, createdAt: new Date(), chatId: id }],
  });

  return createDataStreamResponse({
    execute: (dataStream) => {
      // 修改模型调用方式（关键改动）
      const result = volcClient.chat.completions.create({
        model: 'ep-20250217132838-sbqxx', // 火山模型ID
        stream: true, // 启用流式传输
        messages: [
          {
            role: 'system',
            content: systemPrompt({ selectedChatModel }) // 注入系统提示
          },
          ...messages.map(m => ({
            role: m.role,
            content: m.content
          }))
        ],
        max_tokens: 1000, // 控制响应长度
        temperature: 0.7 // 控制随机性
      });

      // 适配流式响应处理
      const volcStream = new ReadableStream({
        async start(controller) {
          for await (const chunk of result) {
            const content = chunk.choices[0]?.delta?.content || '';
            controller.enqueue(content);
          }
          controller.close();
        }
      });

      // 合并数据流
      volcStream.pipeTo(dataStream);

      return {
        consumeStream: async () => {
          // 可选：添加响应后处理
        },
        mergeIntoDataStream: (stream: ReadableStream) => {
          // 合并其他数据流（如工具调用）
        }
      };
    },
    onError: (error) => {
      console.error('API Error:', error);
      return '服务暂时不可用，请稍后重试';
    }
  });
}

// DELETE方法保持原样
export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');

  if (!id) {
    return new Response('Not Found', { status: 404 });
  }

  const session = await auth();

  if (!session || !session.user) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    const chat = await getChatById({ id });

    if (chat.userId !== session.user.id) {
      return new Response('Unauthorized', { status: 401 });
    }

    await deleteChatById({ id });

    return new Response('Chat deleted', { status: 200 });
  } catch (error) {
    return new Response('An error occurred while processing your request', {
      status: 500,
    });
  }
}
