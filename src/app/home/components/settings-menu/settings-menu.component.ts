import { Component, EventEmitter, Input, Output, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  IonMenu,
  IonHeader,
  IonToolbar,
  IonTitle,
  IonContent,
  IonList,
  IonListHeader,
  IonItem,
  IonLabel,
  IonButton,
  IonRadioGroup,
  IonRadio,
  IonSegment,
  IonSegmentButton,
  IonNote,
} from '@ionic/angular/standalone';
import { TextToSpeech } from '@capacitor-community/text-to-speech';
import { VozService } from '../../../services/voz.service';

@Component({
  selector: 'app-settings-menu',
  standalone: true,
  imports: [
    CommonModule,
    IonMenu,
    IonHeader,
    IonToolbar,
    IonTitle,
    IonContent,
    IonList,
    IonListHeader,
    IonItem,
    IonLabel,
    IonButton,
    IonRadioGroup,
    IonRadio,
    IonSegment,
    IonSegmentButton,
    IonNote,
  ],
  templateUrl: './settings-menu.component.html',
  styleUrls: ['./settings-menu.component.scss'],
})
export class SettingsMenuComponent {
  readonly voz = inject(VozService);

  @Input() isProcessing = false;
  @Input() micTestStatus = '';

  /** O formulário de privacidade do AdMob (UMP) só aparece quando a região exige. */
  @Input() mostrarPrivacidadeAnuncios = false;

  @Output() testMicrophone = new EventEmitter<void>();
  @Output() privacidadeAnuncios = new EventEmitter<void>();

  private static readonly FRASE_DEMONSTRACAO =
    'Oi! Eu sou a Kira. Se gostar desta voz, é só deixar marcada que eu passo a falar assim.';

  /** Ao abrir o menu, garante que a lista de vozes está carregada. */
  aoAbrirMenu(): void {
    void this.voz.carregar();
  }

  async escolherVoz(id: string): Promise<void> {
    this.voz.selecionarVoz(id);
    await this.demonstrar();
  }

  async escolherVelocidade(valor: unknown): Promise<void> {
    const numero = Number(valor);
    if (!numero) {
      return;
    }
    this.voz.selecionarVelocidade(numero);
    await this.demonstrar();
  }

  private async demonstrar(): Promise<void> {
    try {
      await TextToSpeech.stop();
      await this.voz.falar(SettingsMenuComponent.FRASE_DEMONSTRACAO);
    } catch (err) {
      console.warn('diagnostic: demonstração de voz falhou', err);
    }
  }
}
