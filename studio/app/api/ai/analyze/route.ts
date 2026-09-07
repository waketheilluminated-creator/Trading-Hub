import {
  assembleAnalystDataPack,
  attachAnalystHistoryPack,
  marketRefFromContext,
  overlayFromContext,
  type AnalystOverlay,
} from "@/lib/ai-context.ts";
import { runAiProxy, type AiProxyBody } from "@/lib/ai/proxy.ts";

export type AnalyzeBody = AiProxyBody & {
  market?: unknown;
  overlay?: AnalystOverlay;
  range?: unknown;
  lookback?: unknown;
};

export async function POST(request: Request) {
  let body: AnalyzeBody;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON request." }, { status: 400 });
  }

  if (body.mode === "test") return runAiProxy(body);

  const question = body.question?.trim() ?? "";
  const market = body.market != null ? marketRefFromContext({ market: body.market }) : marketRefFromContext(body.context);
  const overlay = body.overlay ?? overlayFromContext(body.context);
  // Client-supplied candles are not treated as historical market series.
  // The model sees backend klines / OI / CVD / history packs assembled here.
  const pack = await assembleAnalystDataPack(market, overlay, {}, {
    question,
    range: body.range ?? body.lookback,
  });
  return runAiProxy({
    ...body,
    context: attachAnalystHistoryPack(body.context, pack),
  });
}
