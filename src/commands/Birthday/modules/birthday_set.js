import { MessageFlags } from 'discord.js';
import { createEmbed, errorEmbed, successEmbed } from '../../../utils/embeds.js';
import { setBirthday } from '../../../services/birthdayService.js';
import { logger } from '../../../utils/logger.js';
import { handleInteractionError } from '../../../utils/errorHandler.js';

import { InteractionHelper } from '../../../utils/interactionHelper.js';
export default {
    async execute(interaction, config, client) {
        try {
            await InteractionHelper.safeDefer(interaction);

            const month = interaction.options.getInteger("Luna");
            const day = interaction.options.getInteger("Ziua");
            const userId = interaction.user.id;
            const guildId = interaction.guildId;

            
            const result = await setBirthday(client, guildId, userId, month, day);
            
            await InteractionHelper.safeEditReply(interaction, {
                embeds: [successEmbed(
                    `Ziua ta de nastere a fost setata pe data de **${result.data.monthName} ${result.data.day}**!`,
                    "Zi de nastere setata! 🎂"
                )]
            });
        } catch (error) {
            logger.error("Birthday set command execution failed", {
                error: error.message,
                stack: error.stack,
                userId: interaction.user.id,
                guildId: interaction.guildId,
                commandName: 'birthday_set'
            });
            await handleInteractionError(interaction, error, {
                commandName: 'birthday_set',
                source: 'birthday_set_module'
            });
        }
    }
};



