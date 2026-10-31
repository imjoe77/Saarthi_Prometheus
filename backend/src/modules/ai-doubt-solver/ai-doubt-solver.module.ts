import { Module } from '@nestjs/common';

import { AiDoubtSolverController } from './ai-doubt-solver.controller';
import { AiDoubtSolverService } from './ai-doubt-solver.service';

/**
 * AI trade-buddy module (design-integration task).
 *
 * The widget layered onto the ported design pages asks questions through
 * `POST /ai-doubt-solver`. No feature module is imported: the endpoint reads no
 * tables, holds no sessions, and depends only on the global config (for the
 * optional AI_MODEL_URL) and the offline knowledge base beside it.
 */
@Module({
  controllers: [AiDoubtSolverController],
  providers: [AiDoubtSolverService],
})
export class AiDoubtSolverModule {}
