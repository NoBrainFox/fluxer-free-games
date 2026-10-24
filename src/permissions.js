// Who may change where the bot posts: the community owner, or members with the
// Administrator or Manage Server permission (same bits as Discord).
const ADMINISTRATOR = 1n << 3n;
const MANAGE_GUILD = 1n << 5n;

export function canManageGuild({ guildId, ownerId, userId, roles, memberRoleIds }) {
  if (ownerId && ownerId === userId) return true;
  const mine = new Set(memberRoleIds);
  let permissions = 0n;
  for (const role of roles) {
    // The @everyone role shares the community's ID and applies to every member.
    if (role.id === guildId || role.name === '@everyone' || mine.has(role.id)) {
      permissions |= BigInt(role.permissions ?? 0);
    }
  }
  return (permissions & (ADMINISTRATOR | MANAGE_GUILD)) !== 0n;
}
