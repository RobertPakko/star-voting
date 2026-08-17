# About

## What is STAR voting?
[STAR voting](https://en.wikipedia.org/wiki/STAR_voting) is a mechansim for conducting elections. It can be used for decisions as serious as choosing a national leader to as trivial as selecting a film for your next movie night. This website allows you to create and respond to polls using STAR voting.

## How does STAR voting work?
STAR voting is an acronym that stands for "Score Then Automated Runoff". It is a combination of [score voting](https://en.wikipedia.org/wiki/Score_voting) and [ranked choice voting](https://en.wikipedia.org/wiki/Instant-runoff_voting) algorithms. The following procedure is used to resolve an election:
1. A ballot with an arbitrary number of options is created.
2. Each voter gives each option a number of stars from 0 up to 5, with 0 being the worst score and 5 being the best score.
3. Once all votes are cast, for each option, a score is calculated reflecting the total number of stars that the option received.
4. The two options with the highest scores are selected as finalists<sup>1</sup>.
5. Among the two finalists, the option that was given a higher score on a greater number of ballots is selected as the winner<sup>2</sup>.

## Why would I want to use STAR voting?
STAR voting has a combination of cohesive properties that not offered in its entirety by any other voting system. STAR voting is:

- __Polarization-resistant__: [Plurality voting](https://en.wikipedia.org/wiki/First-past-the-post_voting) incentivizes two party systems. Multiple similar options can split the vote and lead to an election result that is out of alignment with the will of the electorate. STAR voting resists polarization since many options can be rated highly.
- __Expressive__: [Approval voting](https://en.wikipedia.org/wiki/Approval_voting) solves the above problem, but it doesn't allow voters to express the magnitude of their preference. STAR voting is expressive because voters have various levels of preference that can be assigned to options.
- __Strategy-resistant__: [Score voting](https://en.wikipedia.org/wiki/Score_voting) solves the above problems, but it incentivizes dishonesty. The optimal strategy is often to give the highest score to your preferred candidate and no points to their rivals, potentially degrating into plurality voting. STAR voting is stategy resistant because the optimal strategy is almost<sup>3</sup> always to vote honestly.
- __Accurate__: [Ranked choice voting](https://en.wikipedia.org/wiki/Instant-runoff_voting) solves the above problems, but it's simply innacurate in many cases (enumerated on Wikipedia). STAR voting is accurate because it addresses most<sup>4</sup>situations where ranked choice voting becomes innaccurate.
- __Computable__: [The Kemeny method](https://en.wikipedia.org/wiki/Kemeny_method) solves the above problems, but with many votes it quickly becomes infeasibly computationally complex. Producing an election result using the Kemeny method is an NP-hard problem. STAR voting is computable because it can be trivially computed even with a large number of votes and options.
- __Comprehensible__: [The Schulze method](https://en.wikipedia.org/wiki/Schulze_method) solves the above problems but frankly it's completely incomprehensible without a deep knowledge of directed graph algorithms. STAR voting is comprehensible because anyone can understand its procedure.
- __Transparent__: [Random ballot](https://en.wikipedia.org/wiki/Random_ballot) solves the above problems but it's completely unauditable since true randomness is unverifiable. STAR voting is transparent because its election result can be audited and verified.

### Footnotes

1. A tie in the scoring round is broken in favor of the option that is preferred by more voters in a head-to-head comparison. If all tied options were preferred by the same number of voters then a finalist is chosen randomly between the tied options.
2. A tie in the runoff is broken in favor of the option with the higher total score. If both finalists have the same score then the winner is chosen randomly.
3. [Gibbard's theorem](https://en.wikipedia.org/wiki/Gibbard's_theorem) demonstrates that no deterministic, non-dictatorial voting method can be entirely immune from tactical voting.
4. STAR voting is not perfectly accurate, but all perfectly accurate voting systems either can't be computed reliably, can't be understood reliably, or can't be audited reliably.