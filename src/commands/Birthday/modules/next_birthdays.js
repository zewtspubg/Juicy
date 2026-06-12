import { MessageFlags } from 'discord.js';
import { createEmbed, errorEmbed, successEmbed } from '../../../utils/embeds.js';
import { getUpcomingBirthdays } from '../../../services/birthdayService.js';
import { deleteBirthday } from '../../../utils/database.js';
import { logger } from '../../../utils/logger.js';
import { handleInteractionError } from '../../../utils/errorHandler.js';

import { InteractionHelper } from '../../../utils/interactionHelper.js';
export default {
    async execute(interaction, config, client) {
        try {
            await InteractionHelper.safeDefer(interaction);
            
            
            const next5 = await getUpcomingBirthdays(client, interaction.guildId, 5);

            if (next5.length === 0) {
                return await InteractionHelper.safeEditReply(interaction, {
                    embeds: [
                        createEmbed({
                            title: '❌ Nu au fost gasiti alti sarbatoriti.',
                            description: 'Inca nu sunt zile de nastere setate pe server . Foloseste /birthday set pentru a o seta!',
                            color: 'error'
                        })
                    ]
                });
            }

            const embed = createEmbed({
                title: '🎂 Urmatorii 5 sarbatoriti.',
                description: `Acestia sunt urmatorii 5 sarbatoriti de pe ${interaction.guild.name}:`,
                color: 'info'
            });

            let displayIndex = 0;
            for (const birthday of next5) {
                const member = await interaction.guild.members.fetch(birthday.userId).catch(() => null);
                if (!member) {
                    deleteBirthday(client, interaction.guildId, birthday.userId).catch(() => null);
                    continue;
                }
                displayIndex++;

                let timeUntil = '';
                if (birthday.daysUntil === 0) {
                    timeUntil = '🎉 **Azi!**';
                } else if (birthday.daysUntil === 1) {
                    timeUntil = '📅 **Maine!**';
                } else {
                    timeUntil = `In ${birthday.daysUntil} day${birthday.daysUntil > 1 ? 's' : ''}`;
                }

                embed.addFields({
                    name: `${displayIndex}. ${member.displayName}`,
                    value: `<@${birthday.userId}>\n📅 **Data:** ${birthday.monthName} ${birthday.day}\n⏰ **Timp:** ${timeUntil}`,
                    inline: false
                });
            }

            if (displayIndex === 0) {
                return await InteractionHelper.safeEditReply(interaction, {
                    embeds: [
                        createEmbed({
                            title: '❌ Nu sunt zile de nastere care vor veni',
                            description: 'Nu au fost gasite urmatoarele zile de nastere.',
                            color: 'error'
                        })
                    ]
                });
            }

            embed.setFooter({
                text: 'Foloseste comanda /birthday set pentru a ti seta ziua!',
                iconURL: interaction.guild.iconURL()
            });

            await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
            
            logger.info('Next birthdays retrieved successfully', {
                userId: interaction.user.id,
                guildId: interaction.guildId,
                upcomingCount: displayIndex,
                commandName: 'next_birthdays'
            });
        } catch (error) {
            logger.error('Next birthdays command execution failed', {
                error: error.message,
                stack: error.stack,
                userId: interaction.user.id,
                guildId: interaction.guildId,
                commandName: 'next_birthdays'
            });
            await handleInteractionError(interaction, error, {
                commandName: 'next_birthdays',
                source: 'next_birthdays_module'
            });
        }
    }
};



