import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { Public } from '../../common/decorators/public.decorator';
import { AiDoubtSolverService } from './ai-doubt-solver.service';
import { AskDoubtDto } from './dto/ask-doubt.dto';
import { DoubtAnswerDto } from './dto/doubt-answer.dto';

/**
 * The trade-buddy widget's answer endpoint (design-integration task).
 *
 * Public by necessity and by scope: the widget posts from the page with plain
 * headers, the answer is a general explanation, and no user data or ledger
 * state is read or written. The response shape is the widget's contract —
 * `{ concept, sections }` — because the widget validates exactly that and
 * treats anything else as a broken service.
 */
@ApiTags('ai')
@Controller('ai-doubt-solver')
@Public()
export class AiDoubtSolverController {
  constructor(private readonly aiDoubtSolverService: AiDoubtSolverService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Explain a trading or platform concept for the AI trade-buddy widget',
    description:
      'Answers `{ query, elementContext?, pageContext?, history? }` with `{ concept, sections: { what, simple, howItWorks, example, remember } }`. ' +
      'Answers come from the configured model (AI_MODEL_URL) when present, otherwise from the built-in knowledge base; a model failure falls back to the knowledge base rather than erroring. ' +
      'Public by design: general explanations only, no user data.',
  })
  @ApiOkResponse({ type: DoubtAnswerDto })
  ask(@Body() dto: AskDoubtDto): Promise<DoubtAnswerDto> {
    return this.aiDoubtSolverService.ask(dto);
  }
}
