import { installLocalConversationDeletion } from './src/delete-host.js'
import { installLessons } from './src/lessons.js'
export const name = 'dsh-fold-studio'

export const inject = []

export function apply(ctx) {
  // 教训记忆是可选项：它初始化失败不能连带界面与删除功能一起失效。
  try {
    installLessons(ctx)
  } catch (error) {
    ctx.logger?.warn?.('fold-studio/lessons: 初始化失败，界面功能继续', error)
  }

  ctx.inject(
    [
      'sessionPersistence',
      'sessions',
      'agents',
      'workspaceRegistry',
      'typert',
      'agentLoop',
      'sessionController',
      'sessionQuery',
      'storageDomain',
      'sessionProjectionCache',
    ],
    (scope) => {
      installLocalConversationDeletion(scope)
    },
  )
}
