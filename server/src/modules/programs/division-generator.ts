import { z } from 'zod';

export const divisionGeneratorSchema = z.discriminatedUnion('method', [
  z.object({
    method: z.literal('birth_year'),
    from: z.number().int().min(2).max(30),
    to: z.number().int().min(2).max(30),
    genders: z.array(z.enum(['boys', 'girls', 'coed'])).min(1),
  }),
  z.object({
    method: z.literal('school_grade'),
    from: z.number().int().min(-1).max(12),
    to: z.number().int().min(-1).max(12),
    genders: z.array(z.enum(['boys', 'girls', 'coed'])).min(1),
  }),
]);
export type DivisionGeneratorInput = z.output<typeof divisionGeneratorSchema>;
export type GeneratedDivision = {
  name: string;
  code: string;
  ageLabel: string;
  competitionGender: 'male' | 'female' | 'open';
  eligibility: Record<string, unknown>;
  sortOrder: number;
};

export function generateDivisions(
  input: DivisionGeneratorInput,
): GeneratedDivision[] {
  const parsed = divisionGeneratorSchema.parse(input);
  if (parsed.from > parsed.to)
    throw new RangeError('Division range is reversed');
  if (new Set(parsed.genders).size !== parsed.genders.length)
    throw new RangeError('Duplicate gender');
  const divisions: GeneratedDivision[] = [];
  for (let index = parsed.from; index <= parsed.to; index += 1) {
    for (const gender of parsed.genders) {
      const ageLabel =
        parsed.method === 'birth_year'
          ? `U${String(index)}`
          : index === -1
            ? 'Pre-K'
            : index === 0
              ? 'K'
              : `Grade ${String(index)}`;
      const competitionGender =
        gender === 'boys' ? 'male' : gender === 'girls' ? 'female' : 'open';
      divisions.push({
        name: `${ageLabel} ${gender[0]?.toUpperCase() ?? ''}${gender.slice(1)}`,
        code: `${parsed.method === 'birth_year' ? `U${String(index)}` : `G${String(index)}`}-${gender[0]?.toUpperCase() ?? ''}`,
        ageLabel,
        competitionGender,
        eligibility:
          parsed.method === 'birth_year'
            ? { birthYearAge: index, gender: competitionGender }
            : { grade: index, gender: competitionGender },
        sortOrder: divisions.length,
      });
    }
  }
  return divisions;
}
