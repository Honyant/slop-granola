// Built-in recipes (chat prompt shortcuts) and templates (structure for
// enhanced notes). Seeded once by the first migration; users can add their own.
import type { RecipeSection } from '@shared/types'

interface RecipeSeed {
  slug: string
  title: string
  description: string
  prompt: string
  author: string
  uses: number
  section: RecipeSection
}

export const BUILTIN_RECIPES: readonly RecipeSeed[] = [
  {
    slug: 'list-recent-todos',
    title: 'List recent todos',
    description: 'Pulls every action item from your recent meetings into one checklist.',
    prompt:
      'List every action item and todo from my recent meetings as a checklist grouped by meeting (most recent first). Mark who owns each item when it is clear from the transcript. Skip meetings with no action items.',
    author: 'Granola',
    uses: 912_000,
    section: 'anytime',
  },
  {
    slug: 'coach-me',
    title: 'Coach me Matt',
    description: 'Candid coaching on how you showed up, in the style of an executive coach.',
    prompt:
      'Act as a direct, kind executive coach. Based on what I said in these meetings, tell me: what I did well, where I talked too much or too little, questions I should have asked, and one concrete habit to practise next time. Quote my own words where useful.',
    author: 'Matt',
    uses: 41_000,
    section: 'anytime',
  },
  {
    slug: 'streamline-my-calendar',
    title: 'Streamline my calendar',
    description: 'Finds recurring meetings you could shorten, merge or drop.',
    prompt:
      'Look at my recent meetings and identify ones that could have been shorter, merged, async, or dropped entirely. For each suggestion explain why, citing what was actually discussed.',
    author: 'Granola',
    uses: 27_000,
    section: 'anytime',
  },
  {
    slug: 'write-weekly-recap',
    title: 'Write weekly recap',
    description: 'A skimmable summary of the week across all your meetings.',
    prompt:
      "Write a weekly recap of this week's meetings: key decisions, progress, open questions, and next week's priorities. Use short bullet points under clear headings.",
    author: 'Granola',
    uses: 233_000,
    section: 'anytime',
  },
  {
    slug: 'write-prd',
    title: 'Write PRD',
    description: 'Turns product discussions into a first-draft product requirements doc.',
    prompt:
      'Draft a PRD from these meeting notes with sections: Problem, Goals, Non-goals, Users, Requirements (must/should/could), Open questions, Risks. Only include what was actually discussed; mark gaps as TODO.',
    author: 'Granola',
    uses: 64_000,
    section: 'anytime',
  },
  {
    slug: 'suggest-topics',
    title: 'Suggest topics',
    description: 'Potential topics to cover in this meeting based on context from your previous meetings with the same people.',
    prompt:
      'Suggest 5 topics I should cover in this meeting, based on open threads and commitments from my previous meetings with the same people. One line each, most important first.',
    author: 'Granola',
    uses: 86_000,
    section: 'before',
  },
  {
    slug: 'joke',
    title: 'Joke',
    description: 'Generates a situational joke, anecdote, or fun fact to ease tension and make a call feel more human.',
    prompt:
      'Give me one short, tasteful, situational joke or fun fact related to what is being discussed right now, to lighten the mood. Nothing that could offend.',
    author: 'Eva',
    uses: 10_000,
    section: 'before',
  },
  {
    slug: 'affirm',
    title: 'Affirm',
    description: 'Generates 1-sentence responses to affirm prospects and build rapport during sales calls.',
    prompt:
      'Give me three one-sentence responses I could say right now to affirm what the other person just said and build rapport. Make them specific to the conversation.',
    author: 'Eva',
    uses: 3_100,
    section: 'before',
  },
  {
    slug: 'create-linear-ticket',
    title: 'Create linear ticket',
    description: 'Extracts product and engineering tasks from meeting transcripts for import into Linear.',
    prompt:
      'Extract product and engineering tasks from this meeting as Linear tickets. For each: Title, Description (context from the meeting), Priority (Urgent/High/Medium/Low), and suggested assignee if mentioned.',
    author: 'Vicky (CX Lead at Granola)',
    uses: 3_400,
    section: 'during',
  },
  {
    slug: 'what-does-that-mean',
    title: 'What does that mean',
    description: 'Defines technical terms, explains acronyms and helps you understand jargon in real time.',
    prompt:
      'Explain the technical terms, acronyms and jargon used in the last few minutes of this meeting, one short plain-English definition each.',
    author: 'Granola',
    uses: 3_400,
    section: 'during',
  },
  {
    slug: 'backstory',
    title: 'Backstory',
    description: "Catch me up on what's being discussed.",
    prompt: "Catch me up: in 3-5 bullets, what is being discussed right now and what's the context I need?",
    author: 'Granola',
    uses: 2_000,
    section: 'during',
  },
  {
    slug: 'make-notes-longer',
    title: 'Make notes longer',
    description: 'Rewrites meeting notes so they are longer and more detailed.',
    prompt:
      'Rewrite the notes from this meeting to be longer and more detailed, keeping the same structure but adding specifics, numbers, names and reasoning from the transcript.',
    author: 'Granola',
    uses: 542_000,
    section: 'after',
  },
  {
    slug: 'write-tldr',
    title: 'Write tldr',
    description: 'Two bullet meeting summary for sharing with your team.',
    prompt: 'Write a two-bullet TL;DR of this meeting suitable for pasting into a team channel.',
    author: 'Granola',
    uses: 56_000,
    section: 'after',
  },
  {
    slug: 'write-follow-up-email',
    title: 'Write follow up email',
    description: 'Quick email to send after a meeting recapping next steps.',
    prompt:
      'Write a short, warm follow-up email to the other attendees recapping what we agreed and the next steps with owners and dates. No subject line fluff.',
    author: 'Granola',
    uses: 619_000,
    section: 'after',
  },
]

interface TemplateSeed {
  id: string
  name: string
  description: string
  body: string
}

export const BUILTIN_TEMPLATES: readonly TemplateSeed[] = [
  {
    id: 'meeting',
    name: 'Meeting notes',
    description: 'Adapts to any meeting',
    body: '### Key takeaways\n\n### Discussion\n(one heading per topic discussed)\n\n### Next steps',
  },
  {
    id: 'one-on-one',
    name: '1 on 1',
    description: 'Updates, blockers, feedback, growth',
    body: '### Updates\n\n### Blockers\n\n### Feedback\n\n### Growth & career\n\n### Action items',
  },
  {
    id: 'standup',
    name: 'Stand-up',
    description: 'Yesterday, today, blockers per person',
    body: '### Per person\n(for each person: Yesterday / Today / Blockers)\n\n### Decisions\n\n### Follow-ups',
  },
  {
    id: 'customer-discovery',
    name: 'Customer discovery',
    description: 'Pain points, current workflow, buying signals',
    body: '### About them\n\n### Current workflow\n\n### Pain points\n\n### Buying signals & objections\n\n### Next steps',
  },
  {
    id: 'interview',
    name: 'Interview',
    description: 'Evaluate a candidate',
    body: '### Background\n\n### Technical signal\n\n### Communication\n\n### Concerns\n\n### Recommendation',
  },
  {
    id: 'lecture',
    name: 'Lecture',
    description: 'Concepts, definitions, examples',
    body: '### Summary\n\n### Key concepts\n\n### Definitions\n\n### Examples\n\n### Questions to review',
  },
]
