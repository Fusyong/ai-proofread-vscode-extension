import type {
    ReferencePrepPlan,
    ReferencePrepPlanQuery,
    ReferencePrepProcessFileV020,
} from './schema';

export type PrepPhaseName =
    | 'scope'
    | 'plan'
    | 'plan_review'
    | 'execute'
    | 'rerank'
    | 'done'
    | 'json_item'
    | 'replay';

export type PrepEvent =
    | { type: 'phase'; name: PrepPhaseName; message?: string; round?: number }
    | { type: 'plan'; round: number; plan: ReferencePrepPlan }
    | {
          type: 'planReview';
          round: number;
          plan: ReferencePrepPlan;
          /** 等待用户确认时为 true */
          awaitConfirm: boolean;
      }
    | { type: 'query'; round: number; queryId: string; detail: ReferencePrepPlanQuery }
    | { type: 'hits'; round: number; added: number; total: number }
    | { type: 'process'; process: ReferencePrepProcessFileV020; anchorPath: string }
    | { type: 'error'; message: string }
    | { type: 'cancelled' };

export type PrepEventListener = (event: PrepEvent) => void;

/** 用户确认后的规划（可删减 queries） */
export type PlanReviewResolver = (result: {
    action: 'confirm' | 'skip' | 'cancel';
    plan?: ReferencePrepPlan;
}) => void;

/** 将结构化事件同步桥接到字符串进度（Notification / 旧调用方） */
export function bridgePrepEventToProgress(
    onEvent: PrepEventListener | undefined,
    onProgress: ((msg: string) => void) | undefined
): PrepEventListener | undefined {
    if (!onEvent && !onProgress) return undefined;
    return (event) => {
        onEvent?.(event);
        if (!onProgress) return;
        if (event.type === 'phase' && event.message) {
            onProgress(event.message);
        } else if (event.type === 'error') {
            onProgress(event.message);
        } else if (event.type === 'planReview' && event.awaitConfirm) {
            onProgress(`第 ${event.round + 1} 轮规划待确认（${event.plan.queries.length} 个查询）`);
        }
    };
}
