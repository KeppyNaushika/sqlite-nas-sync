Execute the following git workflow steps in order, targeting only the modifications I made in this session:

1. Add only the files that I modified using git add (exclude changes from other Claude Code instances or manual modifications)
2. Run `npm run format` to format the staged files
3. Run `npm run lint` to check for lint errors. If errors are found, fix them before proceeding
4. Re-add any files modified by formatting/lint fixes
5. Create and switch to a new branch with a unique name (include timestamp to avoid conflicts)
6. Commit the staged changes with an appropriate commit message in Japanese based on my modifications
7. Push the branch to remote repository
8. Create a GitHub Issue in Japanese describing my modifications
9. Create a Pull Request in Japanese linked to the issue
10. Review the Pull Request and rebase it if there are no issues (use `gh pr merge --rebase`)
11. After merging, switch back to main branch and delete the working branch from both local and remote
12. Verify the final state and report completion in Japanese

Important: Target only the modifications I made in this session, excluding any other changes.
