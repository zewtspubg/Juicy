import { MessageFlags } from 'discord.js';
import { createEmbed, errorEmbed, successEmbed } from '../../../utils/embeds.js';
import { getUserBirthday } from '../../../services/birthdayService.js';
import { logger } from '../../../utils/logger.js';
import { handleInteractionError } from '../../../utils/errorHandler.js';

import { InteractionHelper } from '../../../utils/interactionHelper.js';
export default {
    async execute(interaction, config, client) {
        try {
            await InteractionHelper.safeDefer(interaction);

            const targetUser = interaction.options.getUser("user") || interaction.user;
            const userId = targetUser.id;
            const guildId = interaction.guildId;

            
            const birthdayData = await getUserBirthday(client, guildId, userId);

            if (!birthdayData) {
                return await InteractionHelper.safeEditReply(interaction, {
                    embeds: [createEmbed({
                        title: '❌ No Birthday Found',
                        description: targetUser.id === interaction.user.id 
                            ? "Inca nu ai ziua de nastere setata. Foloseste comanda /birthday set pentru a o adauga!"
                            : `${targetUser.username} inca nu are ziua de nastere setata.`,
                        color: 'error'
                    })]
                });
            }
            
            const embed = createEmbed({
                title: "🎂 Informatii despre {user}",
                description: `**Data:** ${birthdayData.monthName} ${birthdayData.day}\n**Persoana:** ${targetUser.toString()}`,
                color: 'info',
                footer: targetUser.id === interaction.user.id ? "Ziua ta de nastere!" : `${targetUser.username}'s Birthday`
            });
            
            await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
            
            logger.info('Informatiile au fost luate!', {
                userId: interaction.user.id,
                targetUserId: targetUser.id,
                guildId,
                commandName: 'birthday_info'
            });
        } catch (error) {
            logger.error("Birthday info command execution failed", {
                error: error.message,
                stack: error.stack,
                userId: interaction.user.id,
                guildId: interaction.guildId,
                commandName: 'birthday_info'
            });
            await handleInteractionError(interaction, error, {
                commandName: 'birthday_info',
                source: 'birthday_info_module'
            });
        }
    }
};



