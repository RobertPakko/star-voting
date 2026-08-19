# STAR Voting

Make a poll, share it, and let people score each option from 0 to 5 stars. The winner is decided by [STAR voting](https://www.starvoting.org/) — *Score Then Automatic Runoff* — which takes the two highest-scoring options and hands the win to whichever of the two more voters preferred.

**[Open the app →](https://choicelab.app/star-voting/)**  ·  [What is STAR voting, and why use it?](https://choicelab.app/star-voting/#/about)

## What you can do with it

- **Run a poll for anything.** Where to eat, which logo, who gets the job. Sign in with an emailed magic link, add your options, send it out.
- **Explain an option when its name doesn't.** Any option can carry a note under it — a caveat, an address, a link to whatever is being voted on — so voters have the detail in front of them while they score, and it's still there beside the result months later. Optional, and most polls never need it.
- **Let the group pick the options too.** A poll can open as a list instead of a ballot: everyone in it suggests options, nobody votes yet, and you open it for voting once the list looks right. Useful when the hard part is working out what the choices even are.
- **Invite people, or just share a link.** Invited polls know who has and hasn't voted and allow one ballot each. Link polls need no sign-in at all — handy, but anyone who has the link can vote, and nothing stops them voting twice.
- **Hand it to a room.** Every poll's link comes with a QR code you can put on a screen or print, so people can scan their way in instead of typing anything.
- **Watch the votes land.** Poll pages keep themselves current while you have them open — turnout, the roster of who has voted, and the moment results unlock, with nothing to reload.
- **Nobody votes knowing how it's going.** Results stay sealed until they unlock: when everyone invited has voted, or whenever you close the poll yourself.
- **See the whole field, not just the winner.** Results give every option's score, the runoff between the two finalists, and — if you want it — the full ranking, every place decided by its own runoff.
- **Publish the ballots if the result needs to be trusted.** Every ballot laid out as a grid so anyone in the poll can check the arithmetic, either with names attached or anonymously.

## The four choices you make up front

They're fixed once the poll exists, so they're worth a moment:

| | |
| --- | --- |
| **Who can vote** | Invited email addresses · Anyone with the link |
| **Who responded** | Show the roster as votes come in · Show only the count |
| **The ballots** | Report totals only · Publish every ballot when results unlock |
| **The options** | You write them · The group suggests them, and you close the list |

Publishing ballots is about *how people voted*; showing respondents is about *whether they voted*. They're independent, and all four combinations of the two are useful — anonymous published ballots give a tally anyone can verify without naming a soul.

Once the poll is running you can close voting early, reset the votes and start over, duplicate the poll into a new one, or delete it outright.

Polls aren't kept forever. Six months after a poll is created, it and every ballot in it are deleted automatically — voting in it or closing it doesn't push that back. Every poll page says which day it goes on, and duplicating a poll starts a fresh one with six months of its own.

## Running your own copy

React + Vite on top of [Supabase](https://supabase.com) (Postgres + Auth), deployed to GitHub Pages. Setup instructions, the database layout, and the reasoning behind the rules above live in [AGENTS.md](AGENTS.md).
