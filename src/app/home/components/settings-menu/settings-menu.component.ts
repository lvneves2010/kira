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
import { ModoVoz, VozService } from '../../../services/voz.service';

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

  async escolherModo(modo: ModoVoz): Promise<void> {
    this.voz.selecionarModo(modo);
    await this.demonstrar(false);
  }

  // A velocidade e a lista de vozes valem para a voz do aparelho,
  // então a prévia usa sempre ela (e não gasta a cota da Leda).
  async escolherVoz(id: string): Promise<void> {
    this.voz.selecionarVoz(id);
    await this.demonstrar(true);
  }

  async escolherVelocidade(valor: unknown): Promise<void> {
    const numero = Number(valor);
    if (!numero) {
      return;
    }
    this.voz.selecionarVelocidade(numero);
    // A velocidade vale para a voz natural e para o aparelho; a Leda fica de fora para não gastar cota.
    await this.demonstrar(this.voz.modo$.value === 'leda');
  }

  ledaEsgotada(ate: number | null): boolean {
    return !!ate && Date.now() < ate;
  }

  private async demonstrar(somenteAparelho: boolean): Promise<void> {
    try {
      await this.voz.parar();
      await this.voz.falar(SettingsMenuComponent.FRASE_DEMONSTRACAO, somenteAparelho);
    } catch (err) {
      console.warn('diagnostic: demonstração de voz falhou', err);
    }
  }
}
