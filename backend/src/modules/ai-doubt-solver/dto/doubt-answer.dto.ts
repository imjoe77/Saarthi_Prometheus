import { ApiProperty } from '@nestjs/swagger';

/** The five sections the widget renders; all five are always strings. */
export class DoubtSectionsDto {
  @ApiProperty({ description: 'Formal definition.', maxLength: 1800 })
  what!: string;

  @ApiProperty({ description: 'One plain sentence — required by the widget.', maxLength: 1800 })
  simple!: string;

  @ApiProperty({ description: 'The mechanics.', maxLength: 1800 })
  howItWorks!: string;

  @ApiProperty({ description: 'A concrete example.', maxLength: 1800 })
  example!: string;

  @ApiProperty({ description: 'The caveat worth remembering.', maxLength: 1800 })
  remember!: string;
}

/** Answer payload: exactly the shape `public/ai-doubt-solver.js` validates. */
export class DoubtAnswerDto {
  @ApiProperty({ description: 'Short heading for the popup.', maxLength: 120, example: 'Impermanent loss' })
  concept!: string;

  @ApiProperty({ type: DoubtSectionsDto })
  sections!: DoubtSectionsDto;
}
